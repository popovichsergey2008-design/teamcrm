import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { BitrixClient } from './bitrix.client';
import { BitrixRepository } from './bitrix.repository';
import { FilesService } from '../../files/files.service';

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

type Ctx = {
  tenantId: string;
  connectionId: string;
  actorId: string | null;
  client: BitrixClient;
  bxUserToLocal: Map<string, string>;
};
type ColResolver = (stageId: any, status: string, closed: boolean) => string;

@Injectable()
export class BitrixImportService {
  private readonly log = new Logger('BitrixImport');

  constructor(
    private readonly repo: BitrixRepository,
    private readonly files: FilesService,
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
    const stages = await ctx.client.stages(groupId);
    const stageToCol = new Map<string, string>();
    let defaults: { name: string; id: string }[] = [];
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
      defaults = await this.repo.ensureDefaultColumns(ctx.tenantId, projectId);
    }
    return (stageId, status, closed) => {
      if (stageId !== undefined && stageToCol.get(String(stageId))) return stageToCol.get(String(stageId))!;
      if (defaults.length) {
        if (closed || status === '5') return defaults[2].id;
        if (status === '3') return defaults[1].id;
        return defaults[0].id;
      }
      return stageToCol.values().next().value as string;
    };
  }

  /** Импорт одной задачи (upsert) + теги + комментарии + вложения. */
  private async importTaskCore(ctx: Ctx, t: any, projectId: string, col: ColResolver, stats: any) {
    const extId = String(f(t, 'id', 'ID'));
    const status = String(f(t, 'status', 'STATUS') ?? '');
    const closed = status === '5' || !!f(t, 'closedDate', 'CLOSED_DATE');
    const columnId = col(f(t, 'stageId', 'STAGE_ID'), status, closed);
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
    const tags = f(t, 'tags', 'TAGS');
    const tagList: string[] = Array.isArray(tags) ? tags : tags ? Object.values(tags).map(String) : [];
    for (const tag of tagList) {
      if (!tag) continue;
      const labelId = await this.repo.ensureLabel(ctx.tenantId, String(tag));
      await this.repo.assignLabel(ctx.tenantId, task.id, labelId);
      stats.labels++;
    }

    // комментарии
    for (const c of await ctx.client.comments(extId)) {
      const body = String(f(c, 'POST_MESSAGE', 'postMessage') ?? '').trim();
      if (!body) continue;
      const localAuthor = ctx.bxUserToLocal.get(String(f(c, 'AUTHOR_ID', 'authorId')));
      const author = localAuthor ?? ctx.actorId;
      if (!author) continue; // нет ни сопоставленного автора, ни актора — пропускаем
      const authorName = String(f(c, 'AUTHOR_NAME', 'authorName') ?? f(c, 'AUTHOR_ID', 'authorId'));
      const finalBody = localAuthor ? body : `[Импортировано из Битрикса, автор: ${authorName}]\n${body}`;
      const d = f(c, 'POST_DATE', 'postDate');
      const inserted = await this.repo.upsertComment({
        tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: String(f(c, 'ID', 'id')), taskId: task.id,
        authorId: author, body: finalBody, postedAt: d ? new Date(d).toISOString() : null,
      });
      if (inserted) stats.comments++;
    }

    // вложения (Bitrix Disk → MinIO). tasks.task.list часто НЕ отдаёт поле файлов —
    // тогда дотягиваем через tasks.task.get.
    let rawFiles = f(t, 'ufTaskWebdavFiles', 'UF_TASK_WEBDAV_FILES');
    if (rawFiles === undefined && ctx.actorId) {
      const full = await ctx.client.taskGet(extId).catch(() => null);
      if (full) rawFiles = f(full, 'ufTaskWebdavFiles', 'UF_TASK_WEBDAV_FILES');
    }
    const fileVals: string[] = Array.isArray(rawFiles) ? rawFiles : rawFiles ? Object.values(rawFiles).map(String) : [];
    for (const raw of fileVals) {
      const val = String(raw);
      const digits = val.replace(/\D/g, '');
      if (!digits || !ctx.actorId) continue; // загрузка файла требует автора (uploaded_by)
      const extFileId = `${extId}:${val}`;
      if (await this.repo.attachmentExists(ctx.connectionId, extFileId)) continue;
      try {
        // id вида "n123" — это attachedObject; чистое число — файл Диска
        const info = /^n/i.test(val)
          ? await ctx.client.attachedObject(digits)
          : await ctx.client.diskFile(digits);
        const url = f(info, 'DOWNLOAD_URL', 'downloadUrl');
        const name = String(f(info, 'NAME', 'name') ?? `file_${digits}`);
        if (!url) { this.log.warn(`file ${extFileId}: нет DOWNLOAD_URL`); continue; }
        const buffer = await ctx.client.download(String(url));
        const uploaded = await this.files.upload({
          tenantId: ctx.tenantId, userId: ctx.actorId, buffer, fileName: name,
          contentType: ctByName(name), ownerKind: 'task_attachment', ownerId: task.id,
        });
        await this.repo.addAttachment({ tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalFileId: extFileId, taskId: task.id, fileId: uploaded.id });
        stats.attachments++;
      } catch (e) {
        this.log.warn(`skip file ${extFileId}: ${(e as Error).message}`);
      }
    }
  }

  /** Полный проход импорта (in-process, статус в import_runs). */
  async run(i: {
    tenantId: string; connectionId: string; webhookUrl: string; projectExternalIds: string[]; runId: string; actorId: string;
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
          await this.importTaskCore(ctx, t, proj.id, col, stats);
        }

        // лента проекта → архив сообщений (best-effort)
        for (const post of await client.groupFeed(String(gid))) {
          const body = String(f(post, 'DETAIL_TEXT', 'detailText', 'POST_TEXT', 'PREVIEW_TEXT') ?? '').trim();
          if (!body) continue;
          const bxAuthor = String(f(post, 'AUTHOR_ID', 'authorId') ?? '');
          const localAuthor = bxUserToLocal.get(bxAuthor) ?? null;
          const postedRaw = f(post, 'DATE_PUBLISH', 'datePublish', 'POST_DATE');
          const inserted = await this.repo.upsertMessage({
            tenantId: i.tenantId, connectionId: i.connectionId, externalId: String(f(post, 'ID', 'id')), projectId: proj.id,
            authorUserId: localAuthor, authorLabel: localAuthor ? null : `Bitrix #${bxAuthor}`, body,
            postedAt: postedRaw ? new Date(postedRaw).toISOString() : null,
          });
          if (inserted) stats.messages++;
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
}
