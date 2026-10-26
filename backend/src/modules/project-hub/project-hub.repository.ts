import { Injectable } from '@nestjs/common';
import { ProjectViewer, viewerParams } from '../../common/access/project-visibility';
import { DbService } from '../../database/db.service';
import { DECISION_VISIBLE } from '../chat-analysis/chat-analysis.repository';
import { estimateCost } from '../ai/usage-catalog';
import { Added } from './hub-rules';

export interface HubProjectRow {
  id: string; name: string; mission: string | null; audience: string | null; description: string | null;
  aliases: string[] | null; target_date: string | null; client_id: string | null; client_name: string | null;
  hub_librarian: boolean; owner_user_id: string | null; status: string;
}

export interface HubItemRow {
  id: string; project_id: string; section: string; kind: string; category: string | null; title: string;
  url: string | null; file_id: string | null; file_name: string | null; body: string | null; contact: any;
  pinned: boolean; sort_order: number; source: string; origin: any; run_id: string | null;
  created_at: Date; created_by: string | null; created_by_name: string | null; removed_at: Date | null;
}

export interface HubMemberRow {
  user_id: string; name: string; avatar_file_id: string | null; role_title: string | null;
  responsibility: string | null; is_owner: boolean;
}

export interface HubDecisionRow {
  id: string; text: string; decided_at: Date; chat_id: string | null; meeting_id: string | null;
  source_message_id: string | null; source_sec: string | null; speaker: string | null;
}

export interface HubRunRow {
  id: string; project_id: string; run_date: string; trigger: string; status: string; added: Partial<Added>;
  used_model: boolean; started_at: Date; finished_at: Date | null; window_start: Date; window_end: Date;
}

/** Чаты проекта для библиотекаря: чат самого проекта и ОТКРЫТЫЕ группы/каналы, привязанные к нему. */
const PROJECT_CHAT = (c: string, p: string) => `(${c}.project_id = ${p}
  OR (${c}.linked_project_id = ${p} AND ${c}.is_private = FALSE AND ${c}.kind IN ('group', 'channel')))`;

const ITEM_COLS = `i.id::text, i.project_id::text, i.section, i.kind, i.category, i.title, i.url, i.file_id::text,
  f.file_name, i.body, i.contact, i.pinned, i.sort_order, i.source, i.origin, i.run_id::text, i.created_at,
  i.created_by::text, cu.full_name AS created_by_name, i.removed_at`;
const ITEM_FROM = `project_hub_items i
  LEFT JOIN files f ON f.id = i.file_id
  LEFT JOIN users cu ON cu.id = i.created_by`;

const RUN_COLS = `r.id::text, r.project_id::text, r.run_date::text, r.trigger, r.status, r.added, r.used_model,
  r.started_at, r.finished_at, r.window_start, r.window_end`;

/** Сумма добавленного прогоном — для бейджа: пустой прогон бейдж не зажигает. */
const ADDED_SUM = `(COALESCE((r.added->>'links')::int, 0) + COALESCE((r.added->>'files')::int, 0)
  + COALESCE((r.added->>'contacts')::int, 0) + COALESCE((r.added->>'notes')::int, 0)
  + COALESCE((r.added->>'decisions')::int, 0))`;

/**
 * Хранение Инфоцентра проекта (#4659). Права на проект проверяет сервис ДО любого
 * запроса сюда; решения дополнительно фильтруются по видимости встречи и чата —
 * в Хронике не должно быть того, чего человек не увидел бы в журнале решений.
 */
@Injectable()
export class ProjectHubRepository {
  constructor(private readonly db: DbService) {}

  project(tenantId: string, id: string): Promise<HubProjectRow | null> {
    return this.db.one<HubProjectRow>(
      `SELECT p.id::text, p.name, p.mission, p.audience, p.description, p.aliases, p.target_date::text,
              p.client_id::text, c.name AS client_name, p.hub_librarian, p.owner_user_id::text, p.status
         FROM projects p LEFT JOIN clients c ON c.id = p.client_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, id],
    );
  }

  async patchPassport(tenantId: string, id: string, p: { mission?: string | null; audience?: string | null; description?: string; hubLibrarian?: boolean }): Promise<void> {
    const set: string[] = [];
    const vals: unknown[] = [tenantId, id];
    if (p.mission !== undefined) { vals.push(p.mission); set.push(`mission = $${vals.length}`); }
    if (p.audience !== undefined) { vals.push(p.audience); set.push(`audience = $${vals.length}`); }
    if (p.description !== undefined) { vals.push(p.description); set.push(`description = $${vals.length}`); }
    if (p.hubLibrarian !== undefined) { vals.push(p.hubLibrarian); set.push(`hub_librarian = $${vals.length}`); }
    if (!set.length) return;
    await this.db.query(`UPDATE projects SET ${set.join(', ')}, updated_at = now() WHERE tenant_id = $1 AND id = $2`, vals);
  }

  // ── записи ──

  items(tenantId: string, projectId: string): Promise<HubItemRow[]> {
    return this.db.many<HubItemRow>(
      `SELECT ${ITEM_COLS} FROM ${ITEM_FROM}
        WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.removed_at IS NULL
        ORDER BY i.pinned DESC, i.sort_order, i.created_at DESC, i.id DESC
        LIMIT 500`,
      [tenantId, projectId],
    );
  }

  item(tenantId: string, projectId: string, id: string): Promise<HubItemRow | null> {
    return this.db.one<HubItemRow>(
      `SELECT ${ITEM_COLS} FROM ${ITEM_FROM} WHERE i.tenant_id = $1 AND i.project_id = $2 AND i.id = $3`,
      [tenantId, projectId, id],
    );
  }

  /** Записи прогона — и убранные: окно «Что добавил ИИ» показывает их с пометкой. */
  runItems(tenantId: string, runId: string): Promise<HubItemRow[]> {
    return this.db.many<HubItemRow>(
      `SELECT ${ITEM_COLS} FROM ${ITEM_FROM} WHERE i.tenant_id = $1 AND i.run_id = $2 ORDER BY i.id`,
      [tenantId, runId],
    );
  }

  /** Новая запись. null — такая ссылка в Инфоцентре уже есть (уникальный индекс). */
  async insertItem(i: {
    tenantId: string; projectId: string; section: string; kind: string; category: string | null; title: string;
    url: string | null; fileId: string | null; body: string | null; contact: Record<string, unknown> | null;
    source: 'manual' | 'ai'; origin: Record<string, unknown> | null; runId: string | null; createdBy: string | null;
  }): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO project_hub_items (tenant_id, project_id, section, kind, category, title, url, file_id, body, contact,
                                      source, origin, run_id, created_by, updated_by,
                                      sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12::jsonb,$13,$14,$14,
               (SELECT COALESCE(min(sort_order), 0) - 1 FROM project_hub_items WHERE project_id = $2 AND section = $3))
       ON CONFLICT (tenant_id, project_id, url) WHERE url IS NOT NULL AND removed_at IS NULL DO NOTHING
       RETURNING id::text`,
      [i.tenantId, i.projectId, i.section, i.kind, i.category, i.title, i.url, i.fileId, i.body,
        i.contact ? JSON.stringify(i.contact) : null, i.source, i.origin ? JSON.stringify(i.origin) : null, i.runId, i.createdBy],
    );
    return row?.id ?? null;
  }

  /** Правка человеком: ИИ-запись после неё — ручная, ИИ за неё больше не отвечает. */
  async updateItem(tenantId: string, projectId: string, id: string, userId: string, p: {
    title?: string; category?: string | null; url?: string | null; body?: string | null;
    contact?: Record<string, unknown> | null; pinned?: boolean; section?: string;
  }): Promise<boolean> {
    const set: string[] = [];
    const vals: unknown[] = [tenantId, projectId, id, userId];
    const put = (col: string, v: unknown, cast = '') => { vals.push(v); set.push(`${col} = $${vals.length}${cast}`); };
    if (p.title !== undefined) put('title', p.title);
    if (p.category !== undefined) put('category', p.category);
    if (p.url !== undefined) put('url', p.url);
    if (p.body !== undefined) put('body', p.body);
    if (p.contact !== undefined) put('contact', p.contact ? JSON.stringify(p.contact) : null, '::jsonb');
    if (p.pinned !== undefined) put('pinned', p.pinned);
    if (p.section !== undefined) put('section', p.section);
    if (!set.length) return true;
    const row = await this.db.one<{ id: string }>(
      `UPDATE project_hub_items SET ${set.join(', ')}, source = 'manual', updated_at = now(), updated_by = $4
        WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND removed_at IS NULL RETURNING id::text`,
      vals,
    );
    return !!row;
  }

  async removeItem(tenantId: string, projectId: string, id: string, userId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `UPDATE project_hub_items SET removed_at = now(), removed_by = $4, updated_at = now()
        WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND removed_at IS NULL RETURNING id::text`,
      [tenantId, projectId, id, userId],
    );
    return !!row;
  }

  /** Есть ли активная запись с этой ссылкой (кроме `exceptId`) — для понятной ошибки до вставки. */
  async urlTaken(tenantId: string, projectId: string, url: string, exceptId: string | null = null): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `SELECT id::text FROM project_hub_items
        WHERE tenant_id = $1 AND project_id = $2 AND url = $3 AND removed_at IS NULL
          AND ($4::bigint IS NULL OR id <> $4::bigint) LIMIT 1`,
      [tenantId, projectId, url, exceptId],
    );
    return !!row;
  }

  /** Файл можно положить в Инфоцентр, только если он загружен именно для этого проекта. */
  hubFile(tenantId: string, projectId: string, fileId: string): Promise<{ id: string; file_name: string } | null> {
    return this.db.one(
      `SELECT id::text, file_name FROM files
        WHERE tenant_id = $1 AND id = $3 AND owner_kind = 'project_hub' AND owner_id = $2`,
      [tenantId, projectId, fileId],
    );
  }

  /** Всё, что ИИ уже видел в проекте — и убранное людьми: убранное утром не возвращается. */
  async known(tenantId: string, projectId: string): Promise<{ urls: Set<string>; fileIds: Set<string>; contacts: Set<string> }> {
    const rows = await this.db.many<{ url: string | null; file_id: string | null; name: string | null }>(
      `SELECT url, file_id::text, lower(contact->>'name') AS name FROM project_hub_items
        WHERE tenant_id = $1 AND project_id = $2`,
      [tenantId, projectId],
    );
    return {
      urls: new Set(rows.map((r) => r.url).filter((x): x is string => !!x)),
      fileIds: new Set(rows.map((r) => r.file_id).filter((x): x is string => !!x)),
      contacts: new Set(rows.map((r) => r.name).filter((x): x is string => !!x)),
    };
  }

  // ── команда ──

  /** Ответственный и участники проекта с ролью и ответственностью; ответственный — первым. */
  members(tenantId: string, projectId: string): Promise<HubMemberRow[]> {
    return this.db.many<HubMemberRow>(
      `SELECT u.id::text AS user_id, u.full_name AS name, u.avatar_file_id::text,
              pm.role_title, pm.responsibility, (p.owner_user_id = u.id) AS is_owner
         FROM projects p
         JOIN users u ON u.tenant_id = p.tenant_id
                     AND (u.id = p.owner_user_id
                          OR EXISTS (SELECT 1 FROM project_members x WHERE x.project_id = p.id AND x.user_id = u.id))
         LEFT JOIN project_members pm ON pm.project_id = p.id AND pm.user_id = u.id
        WHERE p.tenant_id = $1 AND p.id = $2 AND u.is_active
        ORDER BY (p.owner_user_id = u.id) DESC NULLS LAST, u.full_name`,
      [tenantId, projectId],
    );
  }

  /**
   * Роль и ответственность участника. Ответственного за проект, которого нет в списке
   * участников, добавляем строкой: доступа это ему не прибавляет — он и так видит проект.
   */
  async setMember(tenantId: string, projectId: string, userId: string, p: { roleTitle?: string | null; responsibility?: string | null }): Promise<boolean> {
    const ok = await this.db.one<{ ok: boolean }>(
      `SELECT (p.owner_user_id = $3::bigint
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $3::bigint)) AS ok
         FROM projects p WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, projectId, userId],
    );
    if (!ok?.ok) return false;
    await this.db.query(
      `INSERT INTO project_members (tenant_id, project_id, user_id, role_title, responsibility)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (project_id, user_id) DO UPDATE SET
         role_title = CASE WHEN $6::boolean THEN EXCLUDED.role_title ELSE project_members.role_title END,
         responsibility = CASE WHEN $7::boolean THEN EXCLUDED.responsibility ELSE project_members.responsibility END`,
      [tenantId, projectId, userId, p.roleTitle ?? null, p.responsibility ?? null,
        p.roleTitle !== undefined, p.responsibility !== undefined],
    );
    return true;
  }

  // ── решения ──

  /**
   * Хроника — журнал решений проекта, только видимое зрителю (то же правило, что у
   * `/chat-analysis/decisions`): чат — участникам, встреча — как сама встреча.
   * Снятые и заменённые не показываем: Хроника — о действующих договорённостях.
   */
  async decisions(
    tenantId: string, viewer: ProjectViewer, projectId: string,
    o: { before?: string | null; limit?: number; from?: Date | null; to?: Date | null } = {},
  ): Promise<{ items: HubDecisionRow[]; total: number }> {
    const [, all, client] = viewerParams(viewer);
    const where = `d.tenant_id = $1 AND d.project_id = $5 AND d.revoked_at IS NULL AND d.superseded_by IS NULL
          AND (d.chat_id IS NULL OR c.kind = 'project'
               OR EXISTS (SELECT 1 FROM chat_members cm WHERE cm.chat_id = c.id AND cm.user_id = $2::bigint))
          AND ${DECISION_VISIBLE('$3', '$4')}
          AND ($6::timestamptz IS NULL OR d.created_at >= $6::timestamptz)
          AND ($7::timestamptz IS NULL OR d.created_at < $7::timestamptz)`;
    const from = `decisions d LEFT JOIN chats c ON c.id = d.chat_id LEFT JOIN meetings mt ON mt.id = d.meeting_id`;
    const base = [tenantId, viewer.userId, all, client, projectId, o.from ?? null, o.to ?? null];
    const [items, total] = await Promise.all([
      this.db.many<HubDecisionRow>(
        `SELECT d.id::text, d.text, d.decided_at, d.chat_id::text, d.meeting_id::text, d.source_message_id::text,
                d.source_sec::text, d.speaker
           FROM ${from}
          WHERE ${where}
            AND ($8::bigint IS NULL OR d.id < $8::bigint)
          ORDER BY d.decided_at DESC, d.id DESC
          LIMIT $9`,
        [...base, o.before ?? null, Math.min(Math.max(o.limit ?? 20, 1), 100)],
      ),
      this.db.one<{ n: number }>(`SELECT count(*)::int AS n FROM ${from} WHERE ${where}`, base),
    ]);
    return { items, total: total?.n ?? 0 };
  }

  /** Сколько решений записано в проекте за окно — для «+N решений» в бейдже (без учёта зрителя). */
  async decisionsCount(tenantId: string, projectId: string, from: Date, to: Date): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM decisions
        WHERE tenant_id = $1 AND project_id = $2 AND revoked_at IS NULL
          AND created_at >= $3 AND created_at < $4`,
      [tenantId, projectId, from, to],
    );
    return row?.n ?? 0;
  }

  // ── прогоны и бейдж ──

  lastRun(tenantId: string, projectId: string): Promise<HubRunRow | null> {
    return this.db.one<HubRunRow>(
      `SELECT ${RUN_COLS} FROM hub_librarian_runs r
        WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.status = 'done'
        ORDER BY r.id DESC LIMIT 1`,
      [tenantId, projectId],
    );
  }

  /** Последний прогон, который что-то добавил и который человек ещё не смотрел. */
  unseenRun(tenantId: string, projectId: string, userId: string): Promise<HubRunRow | null> {
    return this.db.one<HubRunRow>(
      `SELECT ${RUN_COLS} FROM hub_librarian_runs r
        WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.status = 'done' AND ${ADDED_SUM} > 0
          AND r.id > COALESCE((SELECT s.seen_run_id FROM hub_seen s WHERE s.user_id = $3 AND s.project_id = $2), 0)
        ORDER BY r.id DESC LIMIT 1`,
      [tenantId, projectId, userId],
    );
  }

  run(tenantId: string, projectId: string, runId: string): Promise<HubRunRow | null> {
    return this.db.one<HubRunRow>(
      `SELECT ${RUN_COLS} FROM hub_librarian_runs r WHERE r.tenant_id = $1 AND r.project_id = $2 AND r.id = $3`,
      [tenantId, projectId, runId],
    );
  }

  /** Бейдж гаснет: отметка не откатывается назад, если открыли старый прогон. */
  async markSeen(tenantId: string, userId: string, projectId: string, runId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO hub_seen (tenant_id, user_id, project_id, seen_run_id) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, project_id) DO UPDATE
         SET seen_run_id = GREATEST(hub_seen.seen_run_id, EXCLUDED.seen_run_id), seen_at = now()`,
      [tenantId, userId, projectId, runId],
    );
  }

  /**
   * Проекты, которым пора утренний прогон: у компании наступило 8 утра, сегодня прогона
   * не было, проект живой, библиотекарь не выключен и за сутки в проекте что-то было.
   */
  dueProjects(now: Date, hour = 8): Promise<{ tenant_id: string; project_id: string; local_date: string }[]> {
    const local = `(($1::timestamptz) AT TIME ZONE COALESCE(t.timezone, 'Europe/Moscow'))`;
    return this.db.many(
      `SELECT p.tenant_id::text, p.id::text AS project_id, ${local}::date::text AS local_date
         FROM projects p JOIN tenants t ON t.id = p.tenant_id
        WHERE p.status <> 'archived' AND p.hub_librarian
          AND EXTRACT(HOUR FROM ${local}) >= $2
          AND NOT EXISTS (SELECT 1 FROM hub_librarian_runs r
                           WHERE r.project_id = p.id AND r.trigger = 'auto' AND r.run_date = ${local}::date)
          AND (EXISTS (SELECT 1 FROM chat_messages m JOIN chats c ON c.id = m.chat_id
                        WHERE m.tenant_id = p.tenant_id AND ${PROJECT_CHAT('c', 'p.id')}
                          AND m.created_at >= $1::timestamptz - interval '24 hours')
               OR EXISTS (SELECT 1 FROM meetings mt WHERE mt.tenant_id = p.tenant_id AND mt.project_id = p.id
                           AND COALESCE(mt.happened_at, mt.created_at) >= $1::timestamptz - interval '24 hours')
               OR EXISTS (SELECT 1 FROM tasks k WHERE k.tenant_id = p.tenant_id AND k.project_id = p.id
                           AND k.closed_at >= $1::timestamptz - interval '24 hours')
               OR EXISTS (SELECT 1 FROM decisions d WHERE d.tenant_id = p.tenant_id AND d.project_id = p.id
                           AND d.created_at >= $1::timestamptz - interval '24 hours'))
        ORDER BY p.tenant_id, p.id
        LIMIT 500`,
      [now, hour],
    );
  }

  /** Занять утро проекта ДО работы. null — его уже занял другой экземпляр или тик. */
  async claimAuto(tenantId: string, projectId: string, localDate: string, from: Date, to: Date): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO hub_librarian_runs (tenant_id, project_id, run_date, trigger, window_start, window_end)
       VALUES ($1, $2, $3::date, 'auto', $4, $5)
       ON CONFLICT (tenant_id, project_id, run_date) WHERE trigger = 'auto' DO NOTHING
       RETURNING id::text`,
      [tenantId, projectId, localDate, from, to],
    );
    return row?.id ?? null;
  }

  /** Ручной прогон. null — прогон по проекту уже идёт (двойное нажатие, утренний тик). */
  async startManual(tenantId: string, projectId: string, userId: string, from: Date, to: Date): Promise<string | null> {
    return this.db.withTransaction(async (c) => {
      // замок на проект: два нажатия подряд не запустят два прогона
      await c.query(`SELECT 1 FROM projects WHERE id = $1 FOR UPDATE`, [projectId]);
      const busy = (await c.query(
        `SELECT 1 FROM hub_librarian_runs WHERE project_id = $1 AND status = 'running'
            AND started_at > now() - interval '10 minutes' LIMIT 1`,
        [projectId],
      )).rows[0];
      if (busy) return null;
      const row = (await c.query(
        `INSERT INTO hub_librarian_runs (tenant_id, project_id, run_date, trigger, requested_by, window_start, window_end)
         VALUES ($1, $2, (($5::timestamptz) AT TIME ZONE COALESCE((SELECT timezone FROM tenants WHERE id = $1), 'Europe/Moscow'))::date,
                 'manual', $3, $4, $5)
         RETURNING id::text`,
        [tenantId, projectId, userId, from, to],
      )).rows[0];
      return row ? String(row.id) : null;
    });
  }

  async finishRun(runId: string, o: { status: 'done' | 'failed' | 'skipped'; added: Added; usedModel: boolean; error?: string | null }): Promise<void> {
    await this.db.query(
      `UPDATE hub_librarian_runs SET status = $2, added = $3::jsonb, used_model = $4, error = $5, finished_at = now()
        WHERE id = $1`,
      [runId, o.status, JSON.stringify(o.added), o.usedModel, o.error ?? null],
    );
  }

  // ── сбор событий за сутки (только этот проект) ──

  /** Сообщения людей в чатах проекта со ссылками или файлами. */
  chatFinds(tenantId: string, projectId: string, from: Date, to: Date): Promise<{
    id: string; chat_id: string; body: string | null; author: string | null;
    files: { id: string; name: string; contentType: string | null }[];
  }[]> {
    return this.db.many(
      `SELECT m.id::text, m.chat_id::text, m.body, u.full_name AS author,
              COALESCE((SELECT json_agg(json_build_object('id', f.id::text, 'name', f.file_name, 'contentType', f.content_type)
                                        ORDER BY mf.position)
                          FROM chat_message_files mf JOIN files f ON f.id = mf.file_id
                         WHERE mf.message_id = m.id), '[]'::json) AS files
         FROM chat_messages m
         JOIN chats c ON c.id = m.chat_id
         LEFT JOIN users u ON u.id = m.author_id
        WHERE m.tenant_id = $1 AND ${PROJECT_CHAT('c', '$2::bigint')}
          AND m.created_at >= $3 AND m.created_at < $4
          AND m.deleted_at IS NULL AND NOT m.is_ai
          AND (m.body ~* '(https?://|www\\.)' OR EXISTS (SELECT 1 FROM chat_message_files mf WHERE mf.message_id = m.id))
        ORDER BY m.id
        LIMIT 300`,
      [tenantId, projectId, from, to],
    );
  }

  /** Созвоны проекта за сутки — сводка и решения (для модели и подсчёта). */
  meetings(tenantId: string, projectId: string, from: Date, to: Date): Promise<{
    id: string; title: string; summary: string | null; decisions: unknown;
  }[]> {
    return this.db.many(
      `SELECT m.id::text, m.title, s.summary, s.decisions
         FROM meetings m
         LEFT JOIN meeting_summaries s ON s.meeting_id = m.id
         LEFT JOIN chats c ON c.id = m.chat_id
        WHERE m.tenant_id = $1 AND m.status = 'done'
          AND (m.project_id = $2 OR (m.project_id IS NULL AND c.id IS NOT NULL AND ${PROJECT_CHAT('c', '$2::bigint')}))
          AND COALESCE(m.happened_at, m.created_at) >= $3 AND COALESCE(m.happened_at, m.created_at) < $4
        ORDER BY m.id
        LIMIT 20`,
      [tenantId, projectId, from, to],
    );
  }

  /** Задачи проекта, закрытые за сутки: описание и комментарии людей с файлами. */
  closedTasks(tenantId: string, projectId: string, from: Date, to: Date): Promise<{
    id: string; title: string; description: string | null;
    comments: { id: string; body: string | null; files: { id: string; name: string; contentType: string | null }[] }[];
  }[]> {
    return this.db.many(
      `SELECT t.id::text, t.title, t.description,
              COALESCE((SELECT json_agg(json_build_object('id', x.id::text, 'body', x.body, 'files', x.files) ORDER BY x.id)
                          FROM (SELECT c.id, c.body,
                                       COALESCE((SELECT json_agg(json_build_object('id', f.id::text, 'name', f.file_name, 'contentType', f.content_type)
                                                                 ORDER BY cf.position)
                                                   FROM task_comment_files cf JOIN files f ON f.id = cf.file_id
                                                  WHERE cf.comment_id = c.id), '[]'::json) AS files
                                  FROM task_comments c
                                 WHERE c.task_id = t.id AND NOT c.is_ai AND NOT COALESCE(c.is_system, FALSE)
                                 ORDER BY c.id DESC LIMIT 50) x), '[]'::json) AS comments
         FROM tasks t
        WHERE t.tenant_id = $1 AND t.project_id = $2 AND t.deleted_at IS NULL
          AND t.closed_at >= $3 AND t.closed_at < $4
        ORDER BY t.id
        LIMIT 50`,
      [tenantId, projectId, from, to],
    );
  }

  /** Домены сайта проекта из паспорта: ссылки на них — свои, не «знания». */
  async projectSites(tenantId: string, projectId: string): Promise<string[]> {
    const rows = await this.db.many<{ url: string }>(
      `SELECT url FROM project_hub_items
        WHERE tenant_id = $1 AND project_id = $2 AND removed_at IS NULL AND section = 'passport'
          AND category IN ('site', 'app', 'admin') AND url IS NOT NULL`,
      [tenantId, projectId],
    );
    return rows.map((r) => r.url);
  }

  /**
   * Расход библиотекаря за месяц — для потолка. `cost_estimate` у текстовых моделей
   * нулевой (его пишут только за распознавание речи), поэтому цену считаем по токенам,
   * как отчёт о расходах.
   */
  async spentThisMonth(tenantId: string): Promise<number> {
    const rows = await this.db.many<{ model: string; inp: string; out: string; usd: string }>(
      `SELECT model, SUM(input_tokens)::text AS inp, SUM(output_tokens)::text AS out, SUM(cost_estimate)::text AS usd
         FROM ai_usage
        WHERE tenant_id = $1 AND feature = 'hub_librarian' AND created_at >= date_trunc('month', now())
        GROUP BY model`,
      [tenantId],
    );
    return rows.reduce((sum, r) => sum + Math.max(Number(r.usd) || 0, estimateCost(r.model, Number(r.inp) || 0, Number(r.out) || 0)), 0);
  }
}
