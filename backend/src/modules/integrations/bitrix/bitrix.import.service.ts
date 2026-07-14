import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { BitrixClient } from './bitrix.client';
import { BitrixRepository } from './bitrix.repository';
import { FilesService } from '../../files/files.service';
import { AiService } from '../../ai/ai.service';

/** Служебный контейнер для внегрупповых задач и общей ленты. */
export const INBOX_EXTERNAL_ID = '__inbox__';
export const INBOX_NAME = 'Входящие из Битрикса';

const PRIORITY: Record<string, string> = { '0': 'low', '1': 'normal', '2': 'high' };
const f = (o: any, ...keys: string[]) => {
  for (const k of keys) if (o?.[k] !== undefined && o?.[k] !== null) return o[k];
  return undefined;
};
const CT_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  bmp: 'image/bmp', tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', avi: 'video/x-msvideo', mkv: 'video/x-matroska', mpeg: 'video/mpeg', mpg: 'video/mpeg',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', m4a: 'audio/mp4',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ctByName = (name: string) => CT_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

/** Теги Битрикса приходят строками ИЛИ объектами {id,title/name} — нормализуем в имена. */
function tagNames(raw: any): string[] {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : Object.values(raw);
  return arr
    .map((x: any) => (typeof x === 'string' ? x : (x?.title ?? x?.name ?? x?.TITLE ?? x?.NAME ?? '')))
    .map((s: any) => String(s).trim())
    .filter(Boolean);
}

type Ctx = {
  tenantId: string;
  connectionId: string;
  actorId: string | null;
  client: BitrixClient;
  bxUserToLocal: Map<string, string>;
};
type ColResolver = (stageId: any, status: string, closed: boolean) => Promise<string>;

@Injectable()
export class BitrixImportService {
  private readonly log = new Logger('BitrixImport');

  constructor(
    private readonly repo: BitrixRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
  ) {}

  /** Карта bitrixUserId → наш userId: ручные привязки (external_refs) + матч по e-mail. */
  private async buildUserMap(tenantId: string, connectionId: string, client: BitrixClient) {
    const map = await this.repo.userRefs(connectionId);
    const emailMap = await this.repo.userEmailMap(tenantId);
    const unmatched = new Set<string>();
    for (const u of await client.users()) {
      const bxId = String(f(u, 'ID', 'id'));
      if (map.has(bxId)) continue;
      const email = String(f(u, 'EMAIL', 'email') ?? '').toLowerCase();
      const local = email && emailMap.get(email);
      if (local) {
        map.set(bxId, local);
        await this.repo.putRef({ tenantId, connectionId, entityType: 'user', externalId: bxId, localId: local });
      } else {
        unmatched.add(bxId);
      }
    }
    return { map, unmatched };
  }

  /** Создаёт/сопоставляет колонки проекта из стадий Битрикса; возвращает резолвер колонки задачи. */
  private async ensureColumns(ctx: Ctx, projectId: string, groupId: string): Promise<ColResolver> {
    // Служебный контейнер (__inbox__) не соответствует реальной группе Битрикса — сразу дефолтные колонки.
    // Стадии best-effort: нет доступа к группе (task.stages.get → «не можете просматривать задачи в этой группе»)
    // → используем существующие/дефолтные колонки проекта, а не роняем прогон.
    const stages = groupId && !groupId.startsWith('__')
      ? await ctx.client.stages(groupId).catch((e) => {
        this.log.warn(`stages for group ${groupId} unavailable: ${(e as Error).message}`);
        return [] as any[];
      })
      : [];
    const stageToCol = new Map<string, string>();
    if (stages.length) {
      stages.sort((a, b) => Number(f(a, 'SORT', 'sort') ?? 0) - Number(f(b, 'SORT', 'sort') ?? 0));
      for (let idx = 0; idx < stages.length; idx++) {
        const st = stages[idx];
        const colId = await this.repo.upsertColumn({
          tenantId: ctx.tenantId, connectionId: ctx.connectionId, projectId,
          externalId: String(f(st, 'ID', 'id')), name: String(f(st, 'TITLE', 'title') ?? 'Стадия'), position: idx,
        });
        stageToCol.set(String(f(st, 'ID', 'id')), colId);
      }
    } else {
      await this.repo.ensureDefaultColumns(ctx.tenantId, projectId);
    }
    // Ведро по статусу; кэш на проект, чтобы не пересоздавать/перечитывать колонку в рамках прогона.
    const bucketCache = new Map<string, string>();
    return async (stageId, status, closed) => {
      // Стадия задачи есть среди колонок проекта — кладём точно туда.
      if (stageId !== undefined && stageToCol.get(String(stageId))) return stageToCol.get(String(stageId))!;
      // Иначе (напр. внегрупповая задача, размещённая ИИ): подбираем колонку по смыслу статуса,
      // а если подходящей в проекте нет — СОЗДАЁМ её автоматически (get-or-create по синонимам).
      const bucket = (closed || status === '5') ? 'done' : (status === '3' || status === '4') ? 'inprogress' : 'todo';
      const cached = bucketCache.get(bucket);
      if (cached) return cached;
      const colId = await this.repo.ensureColumnByBucket(ctx.tenantId, projectId, bucket);
      bucketCache.set(bucket, colId);
      return colId;
    };
  }

  /** Импорт одной задачи (upsert) + теги + комментарии + вложения. */
  private async importTaskCore(ctx: Ctx, t: any, projectId: string, col: ColResolver, stats: any) {
    const extId = String(f(t, 'id', 'ID'));
    const status = String(f(t, 'status', 'STATUS') ?? '');
    const closed = status === '5' || !!f(t, 'closedDate', 'CLOSED_DATE');
    const columnId = await col(f(t, 'stageId', 'STAGE_ID'), status, closed);
    const assignee = ctx.bxUserToLocal.get(String(f(t, 'responsibleId', 'RESPONSIBLE_ID'))) ?? null;
    const manager = ctx.bxUserToLocal.get(String(f(t, 'createdBy', 'CREATED_BY'))) ?? null;
    const priority = PRIORITY[String(f(t, 'priority', 'PRIORITY') ?? '1')] ?? 'normal';
    const deadlineRaw = f(t, 'deadline', 'DEADLINE');
    const deadlineAt = deadlineRaw ? new Date(deadlineRaw).toISOString() : null;
    const title = String(f(t, 'title', 'TITLE') ?? 'Без названия').slice(0, 255);
    const description = (f(t, 'description', 'DESCRIPTION') ?? null) as string | null;
    const hash = createHash('sha256')
      .update(JSON.stringify([title, description, columnId, assignee, manager, priority, deadlineAt, closed]))
      .digest('hex').slice(0, 40);

    const task = await this.repo.upsertTask({
      tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: extId, projectId, columnId,
      title, description, assigneeId: assignee, createdBy: manager, priority, deadlineAt,
      status: closed ? 'Done' : 'imported', closed, hash,
    });
    stats.tasks++;

    // теги → метки
    for (const tag of tagNames(f(t, 'tags', 'TAGS'))) {
      const labelId = await this.repo.ensureLabel(ctx.tenantId, tag);
      await this.repo.assignLabel(ctx.tenantId, task.id, labelId);
      stats.labels++;
    }

    // комментарии (+ файлы, прикреплённые в комментариях). best-effort: нет доступа к комментам
    // задачи — импортируем саму задачу без них (иначе одна недоступная задача роняла бы весь прогон).
    const taskComments = await ctx.client.comments(extId).catch((e) => {
      this.log.warn(`comments for task ${extId} unavailable: ${(e as Error).message}`);
      return [] as any[];
    });
    for (const c of taskComments) {
      const cId = String(f(c, 'ID', 'id'));
      const body = String(f(c, 'POST_MESSAGE', 'postMessage') ?? '').trim();
      if (body) {
        const localAuthor = ctx.bxUserToLocal.get(String(f(c, 'AUTHOR_ID', 'authorId')));
        const author = localAuthor ?? ctx.actorId;
        if (author) {
          const authorName = String(f(c, 'AUTHOR_NAME', 'authorName') ?? f(c, 'AUTHOR_ID', 'authorId'));
          const finalBody = localAuthor ? body : `[Импортировано из Битрикса, автор: ${authorName}]\n${body}`;
          const d = f(c, 'POST_DATE', 'postDate');
          const inserted = await this.repo.upsertComment({
            tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: cId, taskId: task.id,
            authorId: author, body: finalBody, postedAt: d ? new Date(d).toISOString() : null,
          });
          if (inserted) stats.comments++;
        }
      }
      // ATTACHED_OBJECTS — карта {id:{NAME,DOWNLOAD_URL}}; уже с прямой ссылкой
      const attached = f(c, 'ATTACHED_OBJECTS', 'attachedObjects');
      if (attached && typeof attached === 'object') {
        for (const [aid, info] of Object.entries<any>(attached)) {
          const url = f(info, 'DOWNLOAD_URL', 'downloadUrl');
          const name = String(f(info, 'NAME', 'name') ?? `file_${aid}`);
          if (url) await this.pushFile(ctx, task.id, `c${cId}:${aid}`, name, String(url), stats);
        }
      }
      // UF_FORUM_MESSAGE_DOC — массив id вида n123
      for (const raw of tagNames(f(c, 'UF_FORUM_MESSAGE_DOC', 'ufForumMessageDoc'))) {
        await this.pushFileById(ctx, task.id, `c${cId}:${raw}`, raw, stats);
      }
    }

    // вложения задачи (UF_TASK_WEBDAV_FILES). tasks.task.list часто НЕ отдаёт поле — дотягиваем task.get.
    let rawFiles = f(t, 'ufTaskWebdavFiles', 'UF_TASK_WEBDAV_FILES');
    if (rawFiles === undefined && ctx.actorId) {
      const full = await ctx.client.taskGet(extId).catch(() => null);
      if (full) rawFiles = f(full, 'ufTaskWebdavFiles', 'UF_TASK_WEBDAV_FILES');
    }
    const fileVals: string[] = Array.isArray(rawFiles) ? rawFiles : rawFiles ? Object.values(rawFiles).map(String) : [];
    for (const raw of fileVals) {
      await this.pushFileById(ctx, task.id, `${extId}:${String(raw)}`, String(raw), stats);
    }
  }

  /** Скачивает файл по прямой ссылке и прикрепляет к задаче (идемпотентно). */
  private async pushFile(ctx: Ctx, taskLocalId: string, extFileId: string, name: string, url: string, stats: any) {
    if (!ctx.actorId) return;
    if (await this.repo.attachmentExists(ctx.connectionId, extFileId)) return;
    try {
      const buffer = await ctx.client.download(url);
      const uploaded = await this.files.upload({
        tenantId: ctx.tenantId, userId: ctx.actorId, buffer, fileName: name,
        contentType: ctByName(name), ownerKind: 'task_attachment', ownerId: taskLocalId,
      });
      await this.repo.addAttachment({ tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalFileId: extFileId, taskId: taskLocalId, fileId: uploaded.id });
      stats.attachments++;
    } catch (e) {
      this.log.warn(`skip file ${extFileId}: ${(e as Error).message}`);
    }
  }

  /** Резолвит id (n123 → attachedObject; число → disk.file) и прикрепляет. */
  private async pushFileById(ctx: Ctx, taskLocalId: string, extFileId: string, val: string, stats: any) {
    const digits = String(val).replace(/\D/g, '');
    if (!digits || !ctx.actorId) return;
    if (await this.repo.attachmentExists(ctx.connectionId, extFileId)) return;
    try {
      const info = /^n/i.test(val)
        ? await ctx.client.attachedObject(digits)
        : await ctx.client.diskFile(digits);
      const url = f(info, 'DOWNLOAD_URL', 'downloadUrl');
      const name = String(f(info, 'NAME', 'name') ?? `file_${digits}`);
      if (!url) { this.log.warn(`file ${extFileId}: нет DOWNLOAD_URL`); return; }
      await this.pushFile(ctx, taskLocalId, extFileId, name, String(url), stats);
    } catch (e) {
      this.log.warn(`skip file ${extFileId}: ${(e as Error).message}`);
    }
  }

  /** Фиксирует пропуск задачи: счётчик + до 5 уникальных сообщений (в stats.warnings для показа в UI). */
  private noteSkip(stats: any, externalId: string, e: unknown) {
    const msg = (e as Error).message || 'ошибка';
    this.log.warn(`skip task ${externalId}: ${msg}`);
    stats.skipped = (stats.skipped ?? 0) + 1;
    stats.warnings = stats.warnings ?? [];
    if (!stats.warnings.includes(msg) && stats.warnings.length < 5) stats.warnings.push(msg);
  }

  /** Импорт постов ленты (группы или общей) в архив сообщений проекта (best-effort, идемпотентно). */
  private async importFeed(ctx: Ctx, projectId: string, posts: any[], stats: any) {
    for (const post of posts) {
      const body = String(f(post, 'DETAIL_TEXT', 'detailText', 'POST_TEXT', 'PREVIEW_TEXT') ?? '').trim();
      if (!body) continue;
      const bxAuthor = String(f(post, 'AUTHOR_ID', 'authorId') ?? '');
      const localAuthor = ctx.bxUserToLocal.get(bxAuthor) ?? null;
      const postedRaw = f(post, 'DATE_PUBLISH', 'datePublish', 'POST_DATE');
      const inserted = await this.repo.upsertMessage({
        tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: String(f(post, 'ID', 'id')), projectId,
        authorUserId: localAuthor, authorLabel: localAuthor ? null : `Bitrix #${bxAuthor}`, body,
        postedAt: postedRaw ? new Date(postedRaw).toISOString() : null,
      });
      if (inserted) stats.messages++;
    }
  }

  /** Полный проход импорта (in-process, статус в import_runs). */
  async run(i: {
    tenantId: string; connectionId: string; webhookUrl: string; projectExternalIds: string[]; runId: string; actorId: string;
    includeGeneralFeed?: boolean;
  }): Promise<void> {
    const client = new BitrixClient(i.webhookUrl);
    const stats: any = { projects: 0, columns: 0, tasks: 0, comments: 0, labels: 0, attachments: 0, messages: 0, unmatchedUsers: 0 };
    try {
      await this.repo.setRunRunning(i.runId);
      const { map: bxUserToLocal, unmatched } = await this.buildUserMap(i.tenantId, i.connectionId, client);
      stats.unmatchedUsers = unmatched.size;
      const ctx: Ctx = { tenantId: i.tenantId, connectionId: i.connectionId, actorId: i.actorId, client, bxUserToLocal };

      const groups = await client.groups();
      const groupName = new Map<string, string>();
      for (const g of groups) groupName.set(String(f(g, 'ID', 'id')), String(f(g, 'NAME', 'name') ?? 'Проект'));

      for (const gid of i.projectExternalIds) {
        const proj = await this.repo.upsertProject({
          tenantId: i.tenantId, connectionId: i.connectionId, externalId: gid, name: groupName.get(String(gid)) ?? `Проект ${gid}`,
        });
        stats.projects++;
        const col = await this.ensureColumns(ctx, proj.id, String(gid));

        for (const t of await client.tasks(String(gid))) {
          try {
            await this.importTaskCore(ctx, t, proj.id, col, stats);
          } catch (e) {
            this.noteSkip(stats, String(f(t, 'id', 'ID')), e); // недоступная задача не роняет импорт группы
          }
        }

        // лента проекта → архив сообщений (best-effort)
        await this.importFeed(ctx, proj.id, await client.groupFeed(String(gid)), stats);
        await this.repo.setRunStats(i.runId, stats);
      }

      // общая Живая лента компании → служебный контейнер «Входящие из Битрикса»
      if (i.includeGeneralFeed) {
        const inbox = await this.repo.ensureServiceProject(i.tenantId, i.connectionId, INBOX_NAME);
        try {
          await this.importFeed(ctx, inbox.id, await client.generalFeed(), stats);
        } catch (e) {
          // напр. у вебхука нет права log — не роняем весь импорт, показываем предупреждение
          stats.warnings = [...(stats.warnings ?? []), `Лента не импортирована: ${(e as Error).message}`];
        }
        await this.repo.setRunStats(i.runId, stats);
      }

      await this.repo.finishRun(i.runId, 'done', stats);
    } catch (e) {
      this.log.error(`import run ${i.runId} failed: ${(e as Error).message}`);
      await this.repo.finishRun(i.runId, 'error', stats, (e as Error).message);
    }
  }

  /** Живая синхронизация одной задачи по событию Битрикса. */
  async syncTaskById(i: { tenantId: string; connectionId: string; webhookUrl: string; actorId: string | null; taskId: string }): Promise<void> {
    try {
      const client = new BitrixClient(i.webhookUrl);
      const raw = await client.taskGet(i.taskId);
      if (!raw) return;
      const groupId = String(f(raw, 'groupId', 'GROUP_ID') ?? '');
      const projRef = await this.repo.getRef(i.connectionId, 'project', groupId);
      if (!projRef) { this.log.warn(`event: group ${groupId} not imported — skip task ${i.taskId}`); return; }
      const { map } = await this.buildUserMap(i.tenantId, i.connectionId, client);
      const ctx: Ctx = { tenantId: i.tenantId, connectionId: i.connectionId, actorId: i.actorId, client, bxUserToLocal: map };
      const col = await this.ensureColumns(ctx, projRef.local_id, groupId);
      await this.importTaskCore(ctx, raw, projRef.local_id, col, { tasks: 0, labels: 0, comments: 0, attachments: 0 });
      this.log.log(`event: synced task ${i.taskId} → project ${projRef.local_id}`);
    } catch (e) {
      this.log.error(`syncTaskById ${i.taskId} failed: ${(e as Error).message}`);
    }
  }

  /** Удаление задачи по событию ONTASKDELETE. */
  async deleteTaskByExternal(tenantId: string, connectionId: string, taskId: string): Promise<void> {
    try {
      await this.repo.deleteImportedTask(tenantId, connectionId, taskId);
    } catch (e) {
      this.log.error(`delete task ${taskId} failed: ${(e as Error).message}`);
    }
  }

  // ── ИИ-раскладка внегрупповых задач по проектам ──

  /**
   * Для каждой внегрупповой задачи предлагает наиболее подходящий проект (по названию/описанию).
   * Пытается через LLM (строгий JSON); при отсутствии ключа/сбое парсинга — детерминированная эвристика
   * (совпадение значимых слов задачи с названием проекта). projectId=null → «Входящие» на ручную разборку.
   */
  async classifyUngrouped(
    tenantId: string,
    tasks: { externalId: string; title: string; description?: string | null }[],
    projects: { id: string; name: string }[],
  ): Promise<Map<string, { projectId: string | null; confidence: number }>> {
    const result = new Map<string, { projectId: string | null; confidence: number }>();
    if (!tasks.length) return result;
    if (!projects.length) {
      for (const t of tasks) result.set(t.externalId, { projectId: null, confidence: 0 });
      return result;
    }

    const valid = new Set(projects.map((p) => String(p.id)));
    const byId = new Map<string, { projectId: string | null; confidence: number }>();

    const system =
      'Ты распределяешь задачи по проектам компании. Для КАЖДОЙ задачи выбери НАИБОЛЕЕ подходящий проект ' +
      'из списка по смыслу названия и описания. Если ни один проект явно не подходит — projectId=null. ' +
      'Верни СТРОГО JSON-массив без пояснений: [{"taskId":"<id задачи>","projectId":"<id проекта или null>","confidence":<число 0..1>}].';
    const projectList = projects.map((p) => ({ id: String(p.id), name: p.name }));

    // Батчим: один запрос на ~30 задач — иначе ответ LLM обрезается лимитом токенов и молча теряется.
    const BATCH = 30;
    const batches: typeof tasks[] = [];
    for (let s = 0; s < tasks.length; s += BATCH) batches.push(tasks.slice(s, s + BATCH));

    await Promise.all(batches.map(async (batch) => {
      const user = JSON.stringify({
        projects: projectList,
        tasks: batch.map((t) => ({ id: t.externalId, title: t.title, description: String(t.description ?? '').slice(0, 500) })),
      });
      try {
        const raw = await this.ai.generate(tenantId, system, user, 'bitrix_route', { params: { max_tokens: 2000 } });
        const json = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim());
        const arr: any[] = Array.isArray(json) ? json : Array.isArray(json?.assignments) ? json.assignments : [];
        for (const r of arr) {
          const tid = String(r?.taskId ?? r?.id ?? '');
          if (!tid) continue;
          let pid = r?.projectId === null || r?.projectId === undefined ? null : String(r.projectId);
          if (pid && !valid.has(pid)) pid = null;
          const conf = Math.max(0, Math.min(1, Number(r?.confidence) || 0));
          byId.set(tid, { projectId: pid, confidence: conf });
        }
      } catch {
        /* нет ключа / модель вернула не-JSON / обрезка → этот батч уйдёт в эвристику ниже */
      }
    }));

    for (const t of tasks) {
      result.set(t.externalId, byId.get(t.externalId) ?? this.heuristicMatch(t, projects));
    }
    return result;
  }

  /** Эвристика без LLM: пересечение значимых слов задачи с названием проекта. */
  private heuristicMatch(
    task: { title: string; description?: string | null },
    projects: { id: string; name: string }[],
  ): { projectId: string | null; confidence: number } {
    const words = (s: string) =>
      (s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').split(' ').filter((w) => w.length >= 3);
    const taskWords = new Set([...words(task.title), ...words(String(task.description ?? ''))]);
    let best: { id: string; name: string } | null = null;
    let bestScore = 0;
    for (const p of projects) {
      let score = 0;
      for (const w of words(p.name)) if (taskWords.has(w)) score++;
      if (score > bestScore) { bestScore = score; best = p; }
    }
    if (best && bestScore > 0) return { projectId: String(best.id), confidence: Math.min(0.9, 0.4 + 0.2 * bestScore) };
    return { projectId: null, confidence: 0 };
  }

  /**
   * Применяет раскладку внегрупповых задач (после подтверждения пользователем): каждую задачу импортирует
   * в выбранный проект, либо (projectId пустой) в служебный контейнер «Входящие из Битрикса».
   */
  async applyUngrouped(i: {
    tenantId: string; connectionId: string; webhookUrl: string; runId: string; actorId: string;
    assignments: { externalId: string; projectId?: string | null }[];
  }): Promise<void> {
    const client = new BitrixClient(i.webhookUrl);
    const stats: any = { tasks: 0, comments: 0, labels: 0, attachments: 0, routed: 0, inbox: 0 };
    try {
      await this.repo.setRunRunning(i.runId);
      const { map: bxUserToLocal } = await this.buildUserMap(i.tenantId, i.connectionId, client);
      const ctx: Ctx = { tenantId: i.tenantId, connectionId: i.connectionId, actorId: i.actorId, client, bxUserToLocal };

      // внегрупповые задачи из Битрикса → карта extId → задача
      const byExt = new Map<string, any>();
      for (const t of await client.ungroupedTasks()) byExt.set(String(f(t, 'id', 'ID')), t);

      // допустимые целевые проекты (внешний gid для резолвера колонок)
      const cands = await this.repo.importedProjects(i.tenantId, i.connectionId);
      const gidByProject = new Map(cands.map((c) => [String(c.id), String(c.external_id)]));
      const resolvers = new Map<string, ColResolver>();
      let inboxId: string | null = null;

      for (const a of i.assignments) {
        const t = byExt.get(String(a.externalId));
        if (!t) continue;
        let projId = a.projectId ? String(a.projectId) : null;
        if (projId && !gidByProject.has(projId)) projId = null; // отсеиваем несуществующие/чужие проекты

        let targetId: string;
        let gid: string;
        if (projId) {
          targetId = projId;
          gid = gidByProject.get(projId)!;
        } else {
          if (!inboxId) inboxId = (await this.repo.ensureServiceProject(i.tenantId, i.connectionId, INBOX_NAME)).id;
          targetId = inboxId;
          gid = INBOX_EXTERNAL_ID;
        }

        try {
          let col = resolvers.get(targetId);
          if (!col) { col = await this.ensureColumns(ctx, targetId, gid); resolvers.set(targetId, col); }
          await this.importTaskCore(ctx, t, targetId, col, stats);
          if (projId) stats.routed++; else stats.inbox++;
        } catch (e) {
          this.noteSkip(stats, a.externalId, e); // одна недоступная задача не роняет всю раскладку
        }
        await this.repo.setRunStats(i.runId, stats);
      }
      await this.repo.finishRun(i.runId, 'done', stats);
    } catch (e) {
      this.log.error(`applyUngrouped run ${i.runId} failed: ${(e as Error).message}`);
      await this.repo.finishRun(i.runId, 'error', stats, (e as Error).message);
    }
  }
}
