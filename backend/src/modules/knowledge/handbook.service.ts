import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { DbService } from '../../database/db.service';
import { KnowledgeService } from './knowledge.service';

/** Приставка к названию регламента: по ней справочник видно среди своих документов. */
const PREFIX = 'Справочник TeamCRM · ';
/** Пауза после старта: выкладка не должна ждать индексации справочника. */
const BOOT_DELAY_MS = 30_000;
/** Как часто сверяться потом: организации заводятся и после выкладки. */
const SYNC_EVERY_MS = 6 * 60 * 60 * 1000;

/**
 * Справочник по системе — то, из чего отвечает помощник в службе заботы.
 *
 * Документация лежит рядом с кодом (`backend/handbook/*.md`) и оттуда же загружается
 * в базу знаний обычными регламентами. Почему так:
 *
 * 1. Правится там же, где меняется поведение: раздел переписали — справочник правится
 *    тем же коммитом, а не через полгода «когда дойдут руки».
 * 2. Никакого отдельного хранилища для ИИ: тот же pgvector, тот же поиск, те же права.
 *    Помощник службы заботы и AnthillBot в чате читают ОДИН источник — иначе получаются
 *    две головы с разными знаниями.
 * 3. Держится в актуальном состоянии сам: после выкладки разделы, текст которых
 *    изменился, перезагружаются и переиндексируются. Кнопка в разделе остаётся — но
 *    как способ не ждать, а не как обязанность о ней помнить.
 *
 * Сверяем ТЕКСТ, а не дату файла: выкладка переписывает файлы целиком, и по времени
 * правки справочник «устаревал» бы при каждом релизе, впустую гоняя эмбеддинги.
 */
@Injectable()
export class HandbookService implements OnModuleInit {
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

  onModuleInit(): void {
    const first = setTimeout(() => void this.syncAll(), BOOT_DELAY_MS);
    first.unref?.(); // не держим процесс в тестах и консольных запусках
    // Организации заводятся и между выкладками: без повтора у новой компании
    // помощник до следующего релиза отвечал бы «не нашёл» на любой вопрос о системе.
    const every = setInterval(() => void this.syncAll(), SYNC_EVERY_MS);
    every.unref?.();
  }

  /**
   * Убедиться, что у организации есть справочник — до того, как он понадобится.
   *
   * Зовётся при первом обращении в службу заботы: новая компания спрашивает «как
   * создать задачу» в первые же дни, а ждать общей сверки полдня — значит встретить
   * её отказом. Ничего не делает, если справочник уже загружен.
   */
  async ensure(tenantId: string): Promise<void> {
    try {
      const row = await this.db.one<{ n: string }>(
        `SELECT count(*)::text AS n FROM regulations WHERE tenant_id=$1 AND title LIKE $2`,
        [tenantId, `${PREFIX}%`],
      );
      if (Number(row?.n ?? 0) > 0) return;
      const owner = await this.db.one<{ id: string }>(
        `SELECT u.id::text FROM users u JOIN roles r ON r.id = u.role_id
          WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active ORDER BY u.id LIMIT 1`,
        [tenantId],
      );
      if (owner) await this.load(tenantId, owner.id);
    } catch (e) {
      this.log.warn(`справочник для организации ${tenantId}: ${(e as Error).message}`);
    }
  }

  /** Разделы справочника с диска: имя файла, заголовок, текст. */
  private async read(): Promise<{ file: string; title: string; body: string }[]> {
    let names: string[] = [];
    try {
      names = (await readdir(this.dir)).filter((n) => n.endsWith('.md')).sort();
    } catch (e) {
      this.log.warn(`справочник не найден в ${this.dir}: ${(e as Error).message}`);
      return [];
    }
    const out: { file: string; title: string; body: string }[] = [];
    for (const file of names) {
      const body = (await readFile(join(this.dir, file), 'utf8')).trim();
      // Заголовок раздела — первая строка «# …»; без неё берём имя файла.
      const head = body.split('\n').find((l) => l.startsWith('# '));
      out.push({ file, title: (head ? head.slice(2) : file.replace(/\.md$/, '')).trim(), body });
    }
    return out;
  }

  /** Что из справочника уже лежит в базе знаний этой организации. */
  private async loaded(tenantId: string) {
    const rows = await this.db.many<{ id: string; title: string; body: string; updated_at: Date }>(
      `SELECT id::text, title, body, updated_at FROM regulations WHERE tenant_id=$1 AND title LIKE $2`,
      [tenantId, `${PREFIX}%`],
    );
    return new Map(rows.map((r) => [r.title, r]));
  }

  /**
   * Что сейчас знает помощник: разделы, дата загрузки и пометка «текст изменился».
   *
   * Пометка важнее, чем кажется: документация правится вместе с кодом, и без неё никто
   * не догадается, что справочник в базе знаний отстал от системы.
   */
  async state(tenantId: string) {
    const [files, byTitle] = await Promise.all([this.read(), this.loaded(tenantId)]);
    const sections = files.map((f) => {
      const row = byTitle.get(PREFIX + f.title);
      return {
        title: f.title,
        chars: f.body.length,
        loadedAt: row ? row.updated_at : null,
        /** Текст на диске отличается от загруженного — раздел пора обновить. */
        stale: !row || row.body.trim() !== f.body,
      };
    });
    const dates = sections.map((s) => s.loadedAt).filter(Boolean) as Date[];
    return {
      sections,
      loadedAt: dates.length ? new Date(Math.max(...dates.map((d) => new Date(d).getTime()))).toISOString() : null,
      stale: sections.some((s) => s.stale),
    };
  }

  /** Загрузить справочник в базу знаний: обновить изменившееся и переиндексировать. */
  async load(tenantId: string, userId: string) {
    const [files, byTitle] = await Promise.all([this.read(), this.loaded(tenantId)]);
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const f of files) {
      const title = PREFIX + f.title;
      const row = byTitle.get(title);
      if (row && row.body.trim() === f.body) { unchanged += 1; continue; }
      if (row) {
        await this.db.query(
          `UPDATE regulations SET body=$3, updated_at=now(), is_system=TRUE WHERE tenant_id=$1 AND id=$2`,
          [tenantId, row.id, f.body],
        );
        this.knowledge.enqueue(tenantId, 'regulation', row.id);
        updated += 1;
      } else {
        const created = await this.db.one<{ id: string }>(
          `INSERT INTO regulations (tenant_id, title, body, created_by, is_system)
           VALUES ($1,$2,$3,$4,TRUE) RETURNING id`,
          [tenantId, title, f.body, userId],
        );
        if (created) this.knowledge.enqueue(tenantId, 'regulation', String(created.id));
        added += 1;
      }
    }
    if (added || updated) this.log.log(`справочник: ${added} новых, ${updated} обновлено, ${unchanged} без изменений`);
    return { added, updated, unchanged, total: files.length, ...(await this.state(tenantId)) };
  }

  /**
   * Держим справочник равным выложенному — по всем организациям.
   *
   * Иначе документация живёт в репозитории, а помощник отвечает по прошлогодней:
   * помнить о кнопке после каждого релиза никто не будет.
   */
  async syncAll(): Promise<void> {
    try {
      const tenants = await this.db.many<{ id: string }>(`SELECT id::text FROM tenants`);
      for (const t of tenants) {
        const st = await this.state(t.id);
        if (!st.stale) continue;
        // Автор регламента — владелец организации: у справочника должен быть хозяин.
        const owner = await this.db.one<{ id: string }>(
          `SELECT u.id::text FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active ORDER BY u.id LIMIT 1`,
          [t.id],
        );
        if (!owner) continue;
        await this.load(t.id, owner.id);
      }
    } catch (e) {
      this.log.warn(`справочник не синхронизирован: ${(e as Error).message}`);
    }
  }
}
