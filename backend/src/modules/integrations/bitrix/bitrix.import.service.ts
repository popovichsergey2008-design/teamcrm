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
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
const ctByName = (name: string) => CT_BY_EXT[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

@Injectable()
export class BitrixImportService {
  private readonly log = new Logger('BitrixImport');

  constructor(
    private readonly repo: BitrixRepository,
    private readonly files: FilesService,
  ) {}

  /** Полный проход импорта (in-process, статус в import_runs). */
  async run(i: {
    tenantId: string; connectionId: string; webhookUrl: string; projectExternalIds: string[]; runId: string; actorId: string;
  }): Promise<void> {
    const client = new BitrixClient(i.webhookUrl);
    const stats: any = { projects: 0, columns: 0, tasks: 0, comments: 0, labels: 0, attachments: 0, messages: 0, unmatchedUsers: 0 };
    try {
      await this.repo.setRunRunning(i.runId);

      // 1. пользователи: ручные привязки (external_refs) + матч по e-mail
      const bxUserToLocal = await this.repo.userRefs(i.connectionId);
      const emailMap = await this.repo.userEmailMap(i.tenantId);
      const bxUsers = await client.users();
      const unmatched = new Set<string>();
      for (const u of bxUsers) {
        const email = String(f(u, 'EMAIL', 'email') ?? '').toLowerCase();
        const bxId = String(f(u, 'ID', 'id'));
        if (bxUserToLocal.has(bxId)) continue; // уже привязан вручную
        const local = email && emailMap.get(email);
        if (local) {
          bxUserToLocal.set(bxId, local);
          await this.repo.putRef({ tenantId: i.tenantId, connectionId: i.connectionId, entityType: 'user', externalId: bxId, localId: local });
        } else {
          unmatched.add(bxId);
        }
      }
      stats.unmatchedUsers = unmatched.size;

      // карта групп id → имя
      const groups = await client.groups();
      const groupName = new Map<string, string>();
      for (const g of groups) groupName.set(String(f(g, 'ID', 'id')), String(f(g, 'NAME', 'name') ?? 'Проект'));

      // 2. по каждому выбранному проекту
      for (const gid of i.projectExternalIds) {
        const proj = await this.repo.upsertProject({
          tenantId: i.tenantId, connectionId: i.connectionId, externalId: gid, name: groupName.get(String(gid)) ?? `Проект ${gid}`,
        });
        stats.projects++;

        // колонки из стадий (или дефолтные)
        const stages = await client.stages(String(gid));
        const stageToCol = new Map<string, string>();
        let defaults: { name: string; id: string }[] = [];
        if (stages.length) {
          stages.sort((a, b) => Number(f(a, 'SORT', 'sort') ?? 0) - Number(f(b, 'SORT', 'sort') ?? 0));
          for (let idx = 0; idx < stages.length; idx++) {
            const st = stages[idx];
            const colId = await this.repo.upsertColumn({
              tenantId: i.tenantId, connectionId: i.connectionId, projectId: proj.id,
              externalId: String(f(st, 'ID', 'id')), name: String(f(st, 'TITLE', 'title') ?? 'Стадия'), position: idx,
            });
            stageToCol.set(String(f(st, 'ID', 'id')), colId);
            stats.columns++;
          }
        } else {
          defaults = await this.repo.ensureDefaultColumns(i.tenantId, proj.id);
          stats.columns += defaults.length;
        }
        const colByStatus = (status: string, closed: boolean): string => {
          if (defaults.length) {
            if (closed || status === '5') return defaults[2].id;
            if (status === '3') return defaults[1].id;
            return defaults[0].id;
          }
          // если есть стадии, но у задачи нет stageId — первая колонка
          return stageToCol.values().next().value as string;
        };

        // задачи
        const tasks = await client.tasks(String(gid));
        for (const t of tasks) {
          const extId = String(f(t, 'id', 'ID'));
          const status = String(f(t, 'status', 'STATUS') ?? '');
          const closedDate = f(t, 'closedDate', 'CLOSED_DATE');
          const closed = status === '5' || !!closedDate;
          const stageId = f(t, 'stageId', 'STAGE_ID');
          const columnId = (stageId !== undefined && stageToCol.get(String(stageId))) || colByStatus(status, closed);

          const assignee = bxUserToLocal.get(String(f(t, 'responsibleId', 'RESPONSIBLE_ID'))) ?? null;
          const manager = bxUserToLocal.get(String(f(t, 'createdBy', 'CREATED_BY'))) ?? null;
          const priority = PRIORITY[String(f(t, 'priority', 'PRIORITY') ?? '1')] ?? 'normal';
          const deadlineRaw = f(t, 'deadline', 'DEADLINE');
          const deadlineAt = deadlineRaw ? new Date(deadlineRaw).toISOString() : null;
          const title = String(f(t, 'title', 'TITLE') ?? 'Без названия').slice(0, 255);
          const description = (f(t, 'description', 'DESCRIPTION') ?? null) as string | null;
          const hash = createHash('sha256')
            .update(JSON.stringify([title, description, columnId, assignee, manager, priority, deadlineAt, closed]))
            .digest('hex').slice(0, 40);

          const task = await this.repo.upsertTask({
            tenantId: i.tenantId, connectionId: i.connectionId, externalId: extId, projectId: proj.id, columnId,
            title, description, assigneeId: assignee, createdBy: manager, priority, deadlineAt,
            status: closed ? 'Done' : 'imported', closed, hash,
          });
          stats.tasks++;

          // теги → метки
          const tags = f(t, 'tags', 'TAGS');
          const tagList: string[] = Array.isArray(tags) ? tags : tags ? Object.values(tags).map(String) : [];
          for (const tag of tagList) {
            if (!tag) continue;
            const labelId = await this.repo.ensureLabel(i.tenantId, String(tag));
            await this.repo.assignLabel(i.tenantId, task.id, labelId);
            stats.labels++;
          }

          // комментарии задачи
          const comments = await client.comments(extId);
          for (const c of comments) {
            const body = String(f(c, 'POST_MESSAGE', 'postMessage') ?? '').trim();
            if (!body) continue;
            const cExtId = String(f(c, 'ID', 'id'));
            const bxAuthor = String(f(c, 'AUTHOR_ID', 'authorId'));
            const localAuthor = bxUserToLocal.get(bxAuthor);
            const authorName = String(f(c, 'AUTHOR_NAME', 'authorName') ?? bxAuthor);
            const finalAuthor = localAuthor ?? i.actorId;
            const finalBody = localAuthor ? body : `[Импортировано из Битрикса, автор: ${authorName}]\n${body}`;
            const postedAt = (() => { const d = f(c, 'POST_DATE', 'postDate'); return d ? new Date(d).toISOString() : null; })();
            const inserted = await this.repo.upsertComment({
              tenantId: i.tenantId, connectionId: i.connectionId, externalId: cExtId, taskId: task.id,
              authorId: finalAuthor, body: finalBody, postedAt,
            });
            if (inserted) stats.comments++;
          }

          // вложения задачи (Bitrix Disk → MinIO)
          const rawFiles = f(t, 'ufTaskWebdavFiles', 'UF_TASK_WEBDAV_FILES');
          const fileIds: string[] = Array.isArray(rawFiles) ? rawFiles : rawFiles ? Object.values(rawFiles).map(String) : [];
          for (const raw of fileIds) {
            const diskId = String(raw).replace(/\D/g, '');
            if (!diskId) continue;
            const extFileId = `${extId}:${diskId}`;
            if (await this.repo.attachmentExists(i.connectionId, extFileId)) continue;
            try {
              const info = await client.diskFile(diskId);
              const url = f(info, 'DOWNLOAD_URL', 'downloadUrl');
              const name = String(f(info, 'NAME', 'name') ?? `file_${diskId}`);
              if (!url) continue;
              const buffer = await client.download(String(url));
              const uploaded = await this.files.upload({
                tenantId: i.tenantId, userId: i.actorId, buffer, fileName: name,
                contentType: ctByName(name), ownerKind: 'task_attachment', ownerId: task.id,
              });
              await this.repo.addAttachment({ tenantId: i.tenantId, connectionId: i.connectionId, externalFileId: extFileId, taskId: task.id, fileId: uploaded.id });
              stats.attachments++;
            } catch (e) {
              // неподдерживаемый тип/ошибка скачивания — пропускаем файл, импорт продолжается
              this.log.warn(`skip file ${extFileId}: ${(e as Error).message}`);
            }
          }
        }

        // лента проекта → архив сообщений (best-effort)
        const feed = await client.groupFeed(String(gid));
        for (const post of feed) {
          const body = String(f(post, 'DETAIL_TEXT', 'detailText', 'POST_TEXT', 'PREVIEW_TEXT') ?? '').trim();
          if (!body) continue;
          const pExtId = String(f(post, 'ID', 'id'));
          const bxAuthor = String(f(post, 'AUTHOR_ID', 'authorId') ?? '');
          const localAuthor = bxUserToLocal.get(bxAuthor) ?? null;
          const postedRaw = f(post, 'DATE_PUBLISH', 'datePublish', 'POST_DATE');
          const postedAt = postedRaw ? new Date(postedRaw).toISOString() : null;
          const inserted = await this.repo.upsertMessage({
            tenantId: i.tenantId, connectionId: i.connectionId, externalId: pExtId, projectId: proj.id,
            authorUserId: localAuthor, authorLabel: localAuthor ? null : `Bitrix #${bxAuthor}`, body, postedAt,
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
}
