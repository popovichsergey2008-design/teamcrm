import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { FilesService } from '../../files/files.service';
import { YougileRepository } from './yougile.repository';
import { YougileClient, YgTask, YgMessage } from './yougile.client';

export interface YougileImportMsg {
  tenantId: string; connectionId: string; apiKey: string; boardExternalIds: string[]; runId: string; actorId: string | null;
}

interface Stats { boards: number; columns: number; tasks: number; comments: number; attachments: number; skipped: number; warnings: string[] }

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav',
};
const ctByName = (name: string): string => MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';

/** Имя CRM-проекта из проекта+доски YouGile: доски часто безымянные («Новая доска»),
 *  поэтому берём имя ПРОЕКТА; имя доски добавляем только если у проекта несколько досок. */
function projectName(projectTitle: string, boardTitle: string, multiBoard: boolean): string {
  const p = projectTitle.trim();
  const b = boardTitle.trim();
  const isDefaultBoard = !b || /^(новая доска|board|new board|доска|доска задач)$/i.test(b);
  const name = multiBoard ? `${p || 'Проект'} · ${b || 'доска'}` : (isDefaultBoard ? (p || b) : (b || p));
  return (name || 'Без названия').slice(0, 120);
}

@Injectable()
export class YougileImportService {
  private readonly log = new Logger('YougileImport');

  constructor(
    private readonly repo: YougileRepository,
    private readonly files: FilesService,
  ) {}

  /** Фоновый импорт выбранных досок YouGile: доски→проекты, колонки, задачи (исполнители/сроки). Идемпотентно. */
  async run(msg: YougileImportMsg): Promise<void> {
    const { tenantId, connectionId, runId } = msg;
    const stats: Stats = { boards: 0, columns: 0, tasks: 0, comments: 0, attachments: 0, skipped: 0, warnings: [] };
    await this.repo.setRunRunning(runId);
    try {
      const client = new YougileClient(msg.apiKey);
      const userMap = await this.buildUserMap(client, tenantId, connectionId);

      // проекты (для осмысленных имён), доски и колонки — одним махом
      const [projects, boards, columns] = await Promise.all([client.listProjects(), client.listBoards(), client.listColumns()]);
      const projTitle = new Map(projects.map((p) => [String(p.id), p.title]));
      const boardCount = new Map<string, number>();
      for (const b of boards) boardCount.set(String(b.projectId), (boardCount.get(String(b.projectId)) ?? 0) + 1);
      const colsByBoard = new Map<string, typeof columns>();
      for (const c of columns) {
        if (c.deleted) continue;
        const arr = colsByBoard.get(String(c.boardId)) ?? [];
        arr.push(c); colsByBoard.set(String(c.boardId), arr);
      }

      for (const boardId of msg.boardExternalIds) {
        const board = boards.find((b) => String(b.id) === String(boardId));
        if (!board || board.deleted) { stats.warnings.push(`Доска ${boardId} не найдена`); continue; }

        const name = projectName(projTitle.get(String(board.projectId)) ?? '', board.title ?? '', (boardCount.get(String(board.projectId)) ?? 1) > 1);
        const project = await this.repo.upsertProject({ tenantId, connectionId, externalId: String(board.id), name });
        stats.boards++;

        const cols = colsByBoard.get(String(board.id)) ?? [];
        const localColByExt = new Map<string, string>();
        let pos = 0; // порядок колонок = порядок массива YouGile
        for (const col of cols) {
          const localColId = await this.repo.upsertColumn({ tenantId, connectionId, projectId: project.id, externalId: String(col.id), name: col.title || 'Колонка', position: pos++ });
          localColByExt.set(String(col.id), localColId);
          stats.columns++;
        }
        const fallbackCol = cols.length === 0 ? await this.repo.ensureFallbackColumn(tenantId, project.id) : null;

        for (const col of cols) {
          let tasks: YgTask[] = [];
          try { tasks = await client.listTasks(String(col.id)); }
          catch (e) { stats.warnings.push(`Колонка «${col.title}»: ${(e as Error).message}`); continue; }
          const localColId = localColByExt.get(String(col.id)) ?? fallbackCol!;
          for (const t of tasks) {
            if (t.deleted || t.archived) { stats.skipped++; continue; }
            const localTaskId = await this.importTask(tenantId, connectionId, project.id, localColId, t, userMap);
            stats.tasks++;
            await this.importChat(client, { tenantId, connectionId, actorId: msg.actorId }, String(t.id), localTaskId, userMap, stats);
          }
          await this.repo.setRunStats(runId, stats);
        }
        await this.repo.setRunStats(runId, stats);
      }

      await this.repo.finishRun(runId, 'done', stats);
    } catch (e) {
      this.log.warn(`import run ${runId} failed: ${(e as Error).message}`);
      await this.repo.finishRun(runId, 'error', stats, (e as Error).message);
    }
  }

  /** Карта пользователей YouGile → локальные (ручная привязка > совпадение по e-mail). */
  private async buildUserMap(client: YougileClient, tenantId: string, connectionId: string): Promise<Map<string, string>> {
    const [ygUsers, emailMap, manual] = await Promise.all([
      client.listUsers(), this.repo.userEmailMap(tenantId), this.repo.userRefs(connectionId),
    ]);
    const map = new Map<string, string>();
    for (const u of ygUsers) {
      const local = manual.get(String(u.id)) ?? (u.email ? emailMap.get(u.email.toLowerCase()) : undefined);
      if (local) map.set(String(u.id), local);
    }
    return map;
  }

  /**
   * Живая синхронизация одной задачи по событию вебхука YouGile.
   * Удаление → удаляем локальную задачу; иначе тянем задачу и апсертим (+чат). Идемпотентно.
   */
  async syncOne(msg: { tenantId: string; connectionId: string; apiKey: string; taskExternalId: string; event: string; actorId: string | null }) {
    const { tenantId, connectionId, taskExternalId } = msg;
    try {
      if (/delet/i.test(msg.event)) { await this.repo.deleteImportedTask(tenantId, connectionId, taskExternalId); return; }
      const client = new YougileClient(msg.apiKey);
      const task = await client.getTask(taskExternalId);
      if (!task || task.deleted) { await this.repo.deleteImportedTask(tenantId, connectionId, taskExternalId); return; }
      const target = await this.repo.columnTarget(connectionId, String(task.columnId));
      if (!target) return; // задача из неимпортированной доски — игнорируем
      const userMap = await this.buildUserMap(client, tenantId, connectionId);
      const localTaskId = await this.importTask(tenantId, connectionId, target.projectId, target.columnId, task, userMap);
      const throwaway: Stats = { boards: 0, columns: 0, tasks: 0, comments: 0, attachments: 0, skipped: 0, warnings: [] };
      await this.importChat(client, { tenantId, connectionId, actorId: msg.actorId }, taskExternalId, localTaskId, userMap, throwaway);
    } catch (e) {
      this.log.warn(`syncOne task ${taskExternalId} failed: ${(e as Error).message}`);
    }
  }

  private async importTask(tenantId: string, connectionId: string, projectId: string, columnId: string, t: YgTask, userMap: Map<string, string>) {
    const assigneeId = (t.assigned ?? []).map((u) => userMap.get(String(u))).find(Boolean) ?? null;
    const createdBy = t.createdBy ? userMap.get(String(t.createdBy)) ?? null : null;
    const deadlineMs = t.deadline?.deadline;
    const deadlineAt = deadlineMs ? new Date(Number(deadlineMs)).toISOString() : null;
    const completed = !!t.completed;
    const description = t.description ? String(t.description).slice(0, 20000) : null;
    const hash = createHash('sha256')
      .update([t.title, description ?? '', columnId, (t.assigned ?? []).join(','), deadlineAt ?? '', completed ? '1' : '0'].join('|'))
      .digest('hex').slice(0, 64);
    const { id } = await this.repo.upsertTask({
      tenantId, connectionId, externalId: String(t.id), projectId, columnId,
      title: (t.title || 'Без названия').slice(0, 255), description,
      assigneeId, createdBy, priority: 'normal', deadlineAt,
      status: completed ? 'done' : 'todo', closed: completed, hash,
    });
    return id;
  }

  /** Чат задачи YouGile → комментарии + вложения (файлы сообщений → MinIO). Best-effort, идемпотентно. */
  private async importChat(
    client: YougileClient, ctx: { tenantId: string; connectionId: string; actorId: string | null },
    taskExternalId: string, localTaskId: string, userMap: Map<string, string>, stats: Stats,
  ) {
    let messages: YgMessage[] = [];
    try { messages = await client.taskMessages(taskExternalId); }
    catch { return; } // нет доступа к чату задачи — импортируем задачу без комментариев
    for (const m of messages) {
      if (m.deleted) continue;
      const author = (m.fromUserId ? userMap.get(String(m.fromUserId)) : undefined) ?? ctx.actorId;
      const body = (m.text ?? '').trim();
      const external = `${taskExternalId}:${m.id}`;
      if (body && author) {
        const prefix = m.fromUserId && !userMap.get(String(m.fromUserId)) ? '[Импортировано из YouGile]\n' : '';
        const inserted = await this.repo.upsertComment({
          tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: external, taskId: localTaskId,
          authorId: author, body: (prefix + body).slice(0, 20000),
          postedAt: m.timestamp ? new Date(Number(m.timestamp)).toISOString() : null,
        }).catch(() => false);
        if (inserted) stats.comments++;
      }
      // файлы сообщения → MinIO как вложения задачи
      for (const [idx, file] of (m.files ?? []).entries()) {
        if (!file?.url) continue;
        const extFileId = `${external}:f${idx}`;
        if (await this.repo.attachmentExists(ctx.connectionId, extFileId)) continue;
        try {
          const buffer = await client.download(file.url);
          const name = file.name || `file-${idx}`;
          const uploaded = await this.files.upload({
            tenantId: ctx.tenantId, userId: ctx.actorId ?? author!, buffer, fileName: name,
            contentType: ctByName(name), ownerKind: 'task_attachment', ownerId: localTaskId,
          });
          await this.repo.addAttachment({ tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalFileId: extFileId, taskId: localTaskId, fileId: uploaded.id });
          stats.attachments++;
        } catch (e) {
          stats.warnings.push(`Файл «${file.name ?? extFileId}»: ${(e as Error).message}`);
        }
      }
    }
  }
}
