import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveRepository, ProposalRow } from '../proactive/proactive.repository';
import { fingerprint } from '../proactive/proactive-rules';
import { AUTO_CONFIRM_DELAY_MS, confirmMessage } from './auto-task';

/** Что считаем правкой постановщика: поля, которые он видит в сообщении. */
const SNAP_SQL = "md5(concat_ws('|', t.title, t.description, t.assignee_id, t.project_id, t.deadline_at, t.priority))";

/** Как часто смотреть, не подошло ли время сообщения: 30 секунд ± 5. */
const TICK_MS = 5_000;

interface DueRow {
  task_id: string; tenant_id: string; user_id: string; snap: string;
  info: { projectWhy?: string | null; assigneeWhy?: string | null } | null;
}

/**
 * «Задача поставлена — проверьте» через 30 секунд после автоматической постановки (#4615).
 *
 * Отложенная запись в базе, а не setTimeout: перезапуск сервера посреди этих 30 секунд
 * не теряет сообщение, а два API при выкатке (blue/green) не пришлют его дважды —
 * строку забирает тот, кто первым отметил её отправленной.
 *
 * Сообщение — карточка ящика секретаря (там же push и Telegram по общим правилам) с
 * кнопками «Ок» (задача подтверждена постановщиком) и «Править» (открыть карточку).
 */
@Injectable()
export class AutoConfirmService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('AutoConfirm');
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    private readonly db: DbService,
    private readonly proactive: ProactiveService,
    private readonly proactiveRepo: ProactiveRepository,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'autotask', execute: (a, p, action) => this.execute(a, p, action) });
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.flush(); } catch (e) { this.log.warn(`проход: ${(e as Error).message}`); } finally { this.busy = false; }
  }

  /** Запомнить: через 30 секунд спросить постановщика. Возвращает, когда придёт сообщение. */
  async schedule(
    tenantId: string, userId: string, taskId: string,
    info: { projectWhy: string | null; assigneeWhy: string | null },
  ): Promise<string | null> {
    const row = await this.db.one<{ due_at: Date }>(
      `INSERT INTO task_auto_confirm (task_id, tenant_id, user_id, due_at, snap, info)
       SELECT t.id, t.tenant_id, $3, now() + make_interval(secs => $4), ${SNAP_SQL}, $5::jsonb
         FROM tasks t WHERE t.tenant_id=$1 AND t.id=$2
       ON CONFLICT (task_id) DO NOTHING
       RETURNING due_at`,
      [tenantId, taskId, userId, AUTO_CONFIRM_DELAY_MS / 1000, JSON.stringify(info)],
    );
    return row ? new Date(row.due_at).toISOString() : null;
  }

  /**
   * Отправить всё, чему пришло время. `now` подменяется в тестах. Строка помечается
   * отправленной до отправки: сбой доставки не повторяет сообщение по кругу.
   */
  async flush(now: Date = new Date()): Promise<number> {
    const rows = await this.db.many<DueRow>(
      `UPDATE task_auto_confirm SET sent_at = now()
        WHERE task_id IN (SELECT task_id FROM task_auto_confirm
                           WHERE sent_at IS NULL AND due_at <= $1
                           ORDER BY due_at LIMIT 50 FOR UPDATE SKIP LOCKED)
       RETURNING task_id::text, tenant_id::text, user_id::text, snap, info`,
      [now],
    );
    let sent = 0;
    for (const r of rows) {
      try { if (await this.send(r)) sent += 1; } catch (e) { this.log.warn(`задача ${r.task_id}: ${(e as Error).message}`); }
    }
    return sent;
  }

  private async send(r: DueRow): Promise<boolean> {
    const t = await this.db.one<{
      id: string; title: string; project_id: string; priority: string; deadline_at: Date | null; snap: string;
      project_name: string; assignee_name: string | null;
    }>(
      `SELECT t.id::text, t.title, t.project_id::text, t.priority, t.deadline_at, ${SNAP_SQL} AS snap,
              p.name AS project_name, ua.full_name AS assignee_name
         FROM tasks t JOIN projects p ON p.id = t.project_id
         LEFT JOIN users ua ON ua.id = t.assignee_id
        WHERE t.tenant_id=$1 AND t.id=$2 AND t.deleted_at IS NULL`,
      [r.tenant_id, r.task_id],
    );
    if (!t) return false; // удалили за эти полминуты — спрашивать не о чем
    const [tags, tz] = await Promise.all([
      this.db.many<{ name: string }>(
        `SELECT l.name FROM task_labels tl JOIN labels l ON l.id = tl.label_id
          WHERE tl.tenant_id=$1 AND tl.task_id=$2 ORDER BY l.name`, [r.tenant_id, r.task_id],
      ).catch(() => []),
      this.proactiveRepo.timezoneOf(r.tenant_id, r.user_id).catch(() => 'Europe/Moscow'),
    ]);
    const edited = !!r.snap && t.snap !== r.snap;
    const msg = confirmMessage({
      taskId: t.id, title: t.title, assigneeName: t.assignee_name, projectName: t.project_name,
      deadlineAt: t.deadline_at, priority: t.priority, tags: tags.map((x) => x.name),
      projectWhy: r.info?.projectWhy ?? null, assigneeWhy: r.info?.assigneeWhy ?? null,
      edited, timeZone: tz,
    });
    const link = `/projects/${t.project_id}/task/${t.id}`;
    const row = await this.proactive.propose({
      tenantId: r.tenant_id, userId: r.user_id, skill: 'autotask', kind: 'confirm',
      sourceType: 'task', sourceId: t.id, sourceAt: new Date(), sourceLabel: `Задача #${t.id}`, sourceLink: link,
      title: msg.title, summary: msg.summary, why: msg.why,
      recommend: 'проверить задачу: всё ок — «Ок», нет — «Править»',
      effect: '«Ок» отметит задачу проверенной вами; «Править» откроет её карточку.',
      priority: 1, confidence: 0.95,
      actions: [
        { key: 'ok', label: 'Ок', risk: 'low_write', primary: true },
        { key: 'edit', label: 'Править', link },
      ],
      payload: { taskId: t.id, projectId: t.project_id, edited },
      fingerprint: fingerprint({ skill: 'autotask', sourceType: 'task', sourceId: t.id }),
      expiresAt: new Date(Date.now() + 3 * 86400_000),
    });
    return !!row;
  }

  /** Кнопки карточки: «Ок» — подтверждено постановщиком; «Править» — открыть задачу. */
  private async execute(a: Actor, p: ProposalRow, action: string) {
    const taskId = String((p.payload as { taskId?: string }).taskId ?? p.source_id);
    const projectId = String((p.payload as { projectId?: string }).projectId ?? '');
    const link = projectId ? `/projects/${projectId}/task/${taskId}` : null;
    if (action === 'edit') return { text: 'Откройте задачу и поправьте', link, keepOpen: true };
    if (action !== 'ok') throw AppException.validation('Неизвестное действие');
    const done = await this.db.one<{ id: string }>(
      `UPDATE tasks SET manager_confirmed_at = now()
        WHERE tenant_id=$1 AND id=$2 AND deleted_at IS NULL RETURNING id::text`,
      [a.tenantId, taskId],
    );
    if (!done) throw AppException.notFound('Задача не найдена — возможно, её удалили');
    return { text: 'Готово: задача проверена', link };
  }
}
