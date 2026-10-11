import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { ProactiveRepository } from '../proactive/proactive.repository';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { KnowledgeService, SourceType } from './knowledge.service';

/** Раз в 10 минут: индексация быстрая, но переписка за день переиндексируется целиком. */
const EVERY_MS = 10 * 60_000;
/** Первый запуск переписки — за последний месяц, не за всю историю. */
const CHAT_BACKFILL_DAYS = 30;

/**
 * Пополнение «второй памяти» (ТЗ-21, этап 4). У задач, комментариев, встреч и файлов
 * свои крючки «изменилось — переиндексировать»; у переписки, решений, новостей, заметок
 * о клиентах и проектов их нет — их подбираем по курсору номеров. Встречи один раз
 * переиндексируются заново: раньше они лежали сплошным текстом без секунд.
 */
@Injectable()
export class MemoryIndexer implements OnModuleInit {
  private readonly log = new Logger('MemoryIndexer');
  private last = 0;

  constructor(
    private readonly db: DbService,
    private readonly knowledge: KnowledgeService,
    private readonly scheduler: ProactiveScheduler,
    private readonly settings: ProactiveRepository,
  ) {}

  onModuleInit(): void {
    this.scheduler.add('память: пополнение', async () => {
      if (Date.now() - this.last < EVERY_MS) return;
      this.last = Date.now();
      await this.runAll();
    });
  }

  async runAll(): Promise<void> {
    const tenants = await this.db.many<{ id: string }>(
      `SELECT t.id::text FROM tenants t
        WHERE EXISTS (SELECT 1 FROM chat_messages m WHERE m.tenant_id = t.id AND m.created_at > now() - interval '30 days')
           OR EXISTS (SELECT 1 FROM tasks k WHERE k.tenant_id = t.id AND k.updated_at > now() - interval '30 days')`,
    );
    for (const t of tenants) {
      const s = await this.settings.tenantSettings(t.id);
      if (!s.enabled || !s.secondBrain) continue;
      await this.runTenant(t.id).catch((e) => this.log.warn(`память ${t.id}: ${(e as Error).message}`));
    }
  }

  /** Возвращает, сколько источников поставлено в очередь (для проверок). */
  async runTenant(tenantId: string): Promise<number> {
    let queued = 0;
    queued += await this.chats(tenantId);
    for (const [source, table, type, where] of [
      ['kb_decision', 'decisions', 'decision', 'revoked_at IS NULL'],
      ['kb_news', 'feed_posts', 'news', `deleted_at IS NULL AND status = 'published'`],
      ['kb_client_note', 'client_notes', 'client_note', 'deleted_at IS NULL AND NOT is_private'],
      ['kb_project', 'projects', 'project', 'TRUE'],
      ['kb_meeting_v2', 'meetings', 'meeting', `status = 'done'`],
      // разовая переиндексация старого: у фрагментов появятся дата, автор и ссылка
      ['kb_task_v2', 'tasks', 'task', 'deleted_at IS NULL'],
      ['kb_comment_v2', 'task_comments', 'comment', 'TRUE'],
    ] as const) {
      queued += await this.byCursor(tenantId, source, table, type, where);
    }
    return queued;
  }

  private async cursor(tenantId: string, source: string): Promise<string | null> {
    const row = await this.db.one<{ last_id: string }>(`SELECT last_id::text FROM proactive_cursors WHERE tenant_id=$1 AND source=$2`, [tenantId, source]);
    return row ? row.last_id : null;
  }

  private async setCursor(tenantId: string, source: string, lastId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO proactive_cursors (tenant_id, source, last_id) VALUES ($1,$2,$3)
       ON CONFLICT (tenant_id, source) DO UPDATE SET last_id = GREATEST(proactive_cursors.last_id, EXCLUDED.last_id), updated_at = now()`,
      [tenantId, source, lastId],
    );
  }

  /** Новые строки таблицы после курсора; первый проход — все (их немного: решения, новости, проекты). */
  private async byCursor(tenantId: string, source: string, table: string, type: SourceType, where: string): Promise<number> {
    const cur = (await this.cursor(tenantId, source)) ?? '0';
    const rows = await this.db.many<{ id: string }>(
      `SELECT id::text FROM ${table} WHERE tenant_id = $1 AND id > $2::bigint AND ${where} ORDER BY id LIMIT 1000`,
      [tenantId, cur],
    );
    for (const r of rows) await this.knowledge.enqueue(tenantId, type, r.id);
    if (rows.length) await this.setCursor(tenantId, source, rows[rows.length - 1].id);
    return rows.length;
  }

  /**
   * Переписка: какие дни каких чатов пополнились — тем дням переиндексация. Номер
   * источника — первое сообщение дня в чате.
   */
  private async chats(tenantId: string): Promise<number> {
    let cur = await this.cursor(tenantId, 'kb_chat');
    if (cur === null) {
      const row = await this.db.one<{ id: string | null }>(
        `SELECT (min(id) - 1)::text AS id FROM chat_messages WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2)`,
        [tenantId, CHAT_BACKFILL_DAYS],
      );
      cur = row?.id ?? '0';
    }
    const days = await this.db.many<{ first_id: string; max_id: string }>(
      `WITH fresh AS (
         SELECT id, chat_id, (created_at AT TIME ZONE 'UTC')::date AS day
           FROM chat_messages WHERE tenant_id = $1 AND id > $2::bigint ORDER BY id LIMIT 5000
       ), touched AS (SELECT chat_id, day, max(id) AS max_id FROM fresh GROUP BY chat_id, day)
       SELECT (SELECT min(m.id) FROM chat_messages m
                WHERE m.chat_id = t.chat_id AND m.deleted_at IS NULL AND NOT m.is_ai
                  AND (m.created_at AT TIME ZONE 'UTC')::date = t.day)::text AS first_id,
              t.max_id::text
         FROM touched t`,
      [tenantId, cur],
    );
    let queued = 0;
    let max = cur;
    for (const d of days) {
      if (d.first_id) { await this.knowledge.enqueue(tenantId, 'chat', d.first_id); queued++; }
      if (BigInt(d.max_id) > BigInt(max)) max = d.max_id;
    }
    await this.setCursor(tenantId, 'kb_chat', max);
    return queued;
  }
}
