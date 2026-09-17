import { Injectable, Logger } from '@nestjs/common';
import { readdir, readFile, stat } from 'fs/promises';
import { join } from 'path';
import { DbService } from '../../database/db.service';
import { KnowledgeService } from './knowledge.service';

/** Приставка к названию регламента: по ней справочник видно среди своих документов. */
const PREFIX = 'Справочник TeamCRM · ';

/**
 * Справочник по системе — то, из чего отвечает помощник в службе заботы.
 *
 * Документация лежит рядом с кодом (`backend/handbook/*.md`) и оттуда же
 * загружается в базу знаний обычными регламентами. Почему так:
 *
 * 1. Правится там же, где меняется поведение: раздел переписали — справочник
 *    правится тем же коммитом, а не через полгода «когда дойдут руки».
 * 2. Никакого отдельного хранилища для ИИ: тот же pgvector, тот же поиск, те же
 *    права. Помощник службы заботы и AnthillBot в чате читают ОДИН источник —
 *    иначе получаются две головы с разными знаниями.
 * 3. Загрузка идемпотентна: раздел узнаётся по названию, повторный запуск не
 *    плодит копии, а обновляет текст и переиндексирует.
 */
@Injectable()
export class HandbookService {
  private readonly log = new Logger('Handbook');
  /**
   * `dist/modules/knowledge` → `/app`, `src/modules/knowledge` → `backend/`.
   * Глубина одинаковая, поэтому путь один и тот же в разработке и на сервере.
   */
  private readonly dir = join(__dirname, '..', '..', '..', 'handbook');

  constructor(
    private readonly db: DbService,
    private readonly knowledge: KnowledgeService,
  ) {}

  /** Разделы справочника с диска: имя файла, заголовок, текст, дата правки. */
  private async read(): Promise<{ file: string; title: string; body: string; changedAt: Date }[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.md')).sort();
    } catch (e) {
      this.log.warn(`справочник не найден в ${this.dir}: ${(e as Error).message}`);
      return [];
    }
    const out: { file: string; title: string; body: string; changedAt: Date }[] = [];
    for (const file of names) {
      const path = join(this.dir, file);
      const body = await readFile(path, 'utf8');
      const info = await stat(path);
      // Заголовок раздела — первая строка «# …»; без неё берём имя файла.
      const head = body.split('\n').find((l) => l.startsWith('# '));
      out.push({
        file,
        title: (head ? head.slice(2) : file.replace(/\.md$/, '')).trim(),
        body: body.trim(),
        changedAt: info.mtime,
      });
    }
    return out;
  }

  /**
   * Что сейчас знает помощник: разделы, дата загрузки и пометка «на диске новее».
   *
   * Пометка важнее, чем кажется: документация правится вместе с кодом, и без неё
   * никто не догадается, что справочник в базе знаний отстал от системы.
   */
  async state(tenantId: string) {
    const files = await this.read();
    const loaded = await this.db.many<{ title: string; updated_at: Date; chars: number }>(
      `SELECT title, updated_at, length(body) AS chars
         FROM regulations WHERE tenant_id=$1 AND title LIKE $2`,
      [tenantId, `${PREFIX}%`],
    );
    const byTitle = new Map(loaded.map((r) => [r.title, r]));
    const sections = files.map((f) => {
      const row = byTitle.get(PREFIX + f.title);
      return {
        title: f.title,
        chars: f.body.length,
        loadedAt: row ? row.updated_at : null,
        /** Файл правили после загрузки — справочник в базе знаний устарел. */
        stale: !row || new Date(row.updated_at).getTime() < f.changedAt.getTime() - 1000,
      };
    });
    const dates = sections.map((s) => s.loadedAt).filter(Boolean) as Date[];
    return {
      sections,
      loadedAt: dates.length ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))).toISOString() : null,
      stale: sections.some((s) => s.stale),
    };
  }

  /** Загрузить справочник в базу знаний: обновить тексты и переиндексировать. */
  async load(tenantId: string, userId: string) {
    const files = await this.read();
    let added = 0;
    let updated = 0;
    for (const f of files) {
      const title = PREFIX + f.title;
      const row = await this.db.one<{ id: string }>(
        `SELECT id FROM regulations WHERE tenant_id=$1 AND title=$2 ORDER BY id LIMIT 1`,
        [tenantId, title],
      );
      if (row) {
        await this.db.query(
          `UPDATE regulations SET body=$3, updated_at=now() WHERE tenant_id=$1 AND id=$2`,
          [tenantId, row.id, f.body],
        );
        this.knowledge.enqueue(tenantId, 'regulation', String(row.id));
        updated += 1;
      } else {
        const created = await this.db.one<{ id: string }>(
          `INSERT INTO regulations (tenant_id, title, body, created_by) VALUES ($1,$2,$3,$4) RETURNING id`,
          [tenantId, title, f.body, userId],
        );
        if (created) this.knowledge.enqueue(tenantId, 'regulation', String(created.id));
        added += 1;
      }
    }
    this.log.log(`справочник загружен: ${added} новых, ${updated} обновлено`);
    return { added, updated, total: files.length, ...(await this.state(tenantId)) };
  }
}
