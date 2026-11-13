import { Injectable, Logger } from '@nestjs/common';
import { ProjectViewer } from '../../common/access/project-visibility';
import { safeFetch } from '../../common/net/safe-fetch';
import { FilesService } from '../files/files.service';
import { can } from '../security/permissions';
import { SecurityService } from '../security/security.service';
import { STAGE_LABEL, Stage } from '../tasks/responsibility';
import { LinkCardsRepository } from './link-cards.repository';
import { LinkRef, linkKey, parseQevoLink, sheetTitle } from './link-parse';

export type LinkCard =
  | { kind: 'task' | 'meeting' | 'file'; key: string; hidden: true }
  | {
      kind: 'task'; key: string; id: string; projectId: string; path: string;
      title: string; assigneeName: string | null; deadlineAt: Date | null;
      status: string; stage: string; closed: boolean; comments: number;
      canAccept: boolean; canSetDeadline: boolean;
    }
  | {
      kind: 'meeting'; key: string; id: string; path: string; title: string; at: Date;
      durationSec: number | null; status: string; decisions: number; tasks: number;
    }
  | { kind: 'file'; key: string; id: string; path: string; name: string; size: number; contentType: string }
  | { kind: 'sheet'; key: string; id: string; url: string; title: string | null };

/** На проверке у постановщика: из этих этапов «Принять» закрывает задачу (#4799 BOARD02). */
const ACCEPT_STAGES = new Set(['testing', 'review', 'approval']);
const SHEET_TTL_MS = 60 * 60_000;
const SHEET_CACHE_MAX = 500;

/**
 * Живые карточки ссылок в переписке (#4902, п. 3).
 *
 * Один запрос на всю видимую ленту: клиент собирает ссылки со всех сообщений и
 * спрашивает пачкой, сервер разбирает адреса сам (клиенту в этом не доверяем) и
 * отвечает в том же порядке. Чего человек не видит — `{ hidden: true }`: ни
 * названия, ни исполнителя закрытой задачи в чужой чат не уходит.
 */
@Injectable()
export class LinkCardsService {
  private readonly log = new Logger(LinkCardsService.name);
  /** Названия Google-таблиц: страница за пределами нашей сети, ходить к ней на каждый показ ленты незачем. */
  private readonly sheets = new Map<string, { title: string | null; at: number; pending?: Promise<string | null> }>();

  constructor(
    private readonly repo: LinkCardsRepository,
    private readonly files: FilesService,
    private readonly security: SecurityService,
  ) {}

  async resolve(tenantId: string, viewer: ProjectViewer, urls: string[]): Promise<{ items: (LinkCard | null)[] }> {
    const refs = urls.map((u) => parseQevoLink(u));
    const uniq = new Map<string, LinkRef>();
    for (const r of refs) if (r) uniq.set(linkKey(r), r);
    const ids = (kind: LinkRef['kind']) => [...uniq.values()].filter((r) => r.kind === kind).map((r) => r.id);

    const taskIds = ids('task');
    const [tasks, meetings, perms] = await Promise.all([
      this.repo.tasks(tenantId, taskIds, viewer),
      this.repo.meetings(tenantId, ids('meeting'), viewer),
      taskIds.length ? this.security.permissionsOf(tenantId, String(viewer.userId)) : Promise.resolve({}),
    ]);
    const cards = new Map<string, LinkCard>();

    const mayEdit = can(perms, 'task.edit');
    for (const t of tasks) {
      const closed = !!t.closed_at || t.stage === 'done';
      // «Принять» — как на сервере (assertCanDecide): постановщик, назначенный проверяющий или владелец
      const decider = String(t.created_by ?? '') === String(viewer.userId)
        || String(t.reviewer_id ?? '') === String(viewer.userId) || viewer.role === 'owner';
      cards.set(`task:${t.id}`, {
        kind: 'task', key: `task:${t.id}`, id: t.id, projectId: t.project_id,
        // путь из базы, а не из ссылки: задачу могли перенести в другой проект
        path: `/projects/${t.project_id}/task/${t.id}`,
        title: t.title, assigneeName: t.assignee_name, deadlineAt: t.deadline_at,
        status: closed ? 'Готово' : (t.column_name || STAGE_LABEL[t.stage as Stage] || ''),
        stage: t.stage, closed, comments: Number(t.comments) || 0,
        canAccept: !closed && ACCEPT_STAGES.has(t.stage) && decider && viewer.role !== 'client',
        canSetDeadline: !closed && mayEdit && viewer.role !== 'client',
      });
    }
    for (const m of meetings) {
      cards.set(`meeting:${m.id}`, {
        kind: 'meeting', key: `meeting:${m.id}`, id: m.id, path: `/meetings/${m.id}`, title: m.title, at: m.at,
        durationSec: m.duration_sec, status: m.status, decisions: Number(m.decisions) || 0, tasks: Number(m.tasks) || 0,
      });
    }
    // файлов в одной ленте — единицы; проверка доступа у файлов своя (владелец: задача, чат, встреча)
    await Promise.all(ids('file').map(async (id) => {
      if (!(await this.files.canDownload(tenantId, id, viewer).catch(() => false))) return;
      const f = await this.files.meta(tenantId, id);
      if (!f) return;
      cards.set(`file:${id}`, {
        kind: 'file', key: `file:${id}`, id, path: `/api/files/${id}`,
        name: f.file_name, size: Number(f.size_bytes) || 0, contentType: f.content_type,
      });
    }));
    await Promise.all(ids('sheet').map(async (id) => {
      cards.set(`sheet:${id}`, {
        kind: 'sheet', key: `sheet:${id}`, id, url: `https://docs.google.com/spreadsheets/d/${id}`, title: await this.sheetTitle(id),
      });
    }));

    return {
      items: refs.map((r) => {
        if (!r) return null;
        const key = linkKey(r);
        return cards.get(key) ?? (r.kind === 'sheet' ? null : { kind: r.kind, key, hidden: true as const });
      }),
    };
  }

  /**
   * Название открытой по ссылке таблицы — через safeFetch (без внутренних адресов и
   * с пределом по размеру). Закрытая таблица уводит на вход в аккаунт — тогда null,
   * и карточка пишет просто «Google-таблица». Ошибка сети — тоже null, ленту не роняем.
   */
  private async sheetTitle(id: string): Promise<string | null> {
    const hit = this.sheets.get(id);
    if (hit?.pending) return hit.pending;
    if (hit && Date.now() - hit.at < SHEET_TTL_MS) return hit.title;
    const pending = safeFetch(`https://docs.google.com/spreadsheets/d/${id}/edit`, { timeoutMs: 4000, maxBytes: 300_000, maxRedirects: 3 })
      .then((p) => (p.status === 200 && new URL(p.url).hostname === 'docs.google.com' ? sheetTitle(p.body) : null))
      .catch((e: Error) => { this.log.debug(`sheet ${id}: ${e.message}`); return null; });
    this.sheets.set(id, { title: null, at: Date.now(), pending });
    const title = await pending;
    if (this.sheets.size > SHEET_CACHE_MAX) this.sheets.delete(this.sheets.keys().next().value as string);
    this.sheets.set(id, { title, at: Date.now() });
    return title;
  }
}
