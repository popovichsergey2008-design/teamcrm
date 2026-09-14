import { Injectable, Logger } from '@nestjs/common';
import { FilesService } from '../../files/files.service';
import { YougileRepository } from './yougile.repository';
import { htmlToText } from '../html-text';
import { YougileClient, YgTask, YgMessage } from './yougile.client';
import { chatEchoKey, taskStateHash } from './yougile.hash';
import { buildPriorityMap, EMPTY_PRIORITY_MAP, PriorityMap, priorityFromStickers } from './yougile.priority';
import { buildLabelMap, labelsForTask, StickerLabel } from './yougile.labels';

/**
 * Когда написано сообщение чата YouGile.
 *
 * Поле `timestamp` YouGile у сообщений не отдаёт — и комментарии записывались
 * временем импорта. Старое сообщение, приехавшее вебхуком через месяц, вставало
 * в переписку «сегодняшним», посреди свежих (задача #900). Настоящее время лежит
 * в самом id сообщения: это миллисекунды создания. Берём его, когда оно похоже
 * на правду — 13 цифр, между 2015 годом и сейчас; иначе честнее «сейчас», чем
 * выдуманная дата.
 */
export function messagePostedAt(m: { id: string | number; timestamp?: number }, now = Date.now()): string | null {
  const fromField = Number(m.timestamp);
  const fromId = /^\d{13}$/.test(String(m.id)) ? Number(m.id) : NaN;
  const ms = Number.isFinite(fromField) && fromField > 0 ? fromField : fromId;
  if (!Number.isFinite(ms)) return null;
  const min = Date.UTC(2015, 0, 1);
  if (ms < min || ms > now + 86_400_000) return null;
  return new Date(ms).toISOString();
}


/** Разбор кастомных стикеров YouGile: приоритет + метки. Готовится один раз на прогон. */
interface StickerCtx {
  prio: PriorityMap;
  labels: Map<string, StickerLabel>;
  owned: Set<string>; // локальные метки, заведённые этой интеграцией
}

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
      const stickers = await this.loadStickers(client, connectionId);

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
            const localTaskId = await this.importTask(tenantId, connectionId, project.id, localColId, t, userMap, stickers);
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
      const stickers = await this.loadStickers(client, connectionId);
      const localTaskId = await this.importTask(tenantId, connectionId, target.projectId, target.columnId, task, userMap, stickers);
      const throwaway: Stats = { boards: 0, columns: 0, tasks: 0, comments: 0, attachments: 0, skipped: 0, warnings: [] };
      await this.importChat(client, { tenantId, connectionId, actorId: msg.actorId }, taskExternalId, localTaskId, userMap, throwaway);
    } catch (e) {
      this.log.warn(`syncOne task ${taskExternalId} failed: ${(e as Error).message}`);
    }
  }

  /**
   * Кастомные стикеры компании: один — приоритет, остальные («Тип задачи», «Устройство», …)
   * становятся метками задач. Импорт от них не зависит — без стикеров он валиден,
   * поэтому ошибку не роняем наружу. Но и молчать нельзя: раньше здесь стоял пустой
   * catch, и отказ стикеров выглядел на доске как «у всех задач обычный приоритет и
   * ни одной метки», без единой строки в логе. Пишем и отказ, и то, какой стикер
   * опознан приоритетом, — иначе непонятно, стикеров нет или название не подошло.
   */
  private async loadStickers(client: YougileClient, connectionId: string): Promise<StickerCtx> {
    try {
      const stickers = await client.listStringStickers();
      const prio = buildPriorityMap(stickers);
      const labels = buildLabelMap(stickers, prio.stickerId);
      if (prio.stickerId) {
        const name = stickers.find((s) => String(s.id) === prio.stickerId)?.name ?? '?';
        this.log.log(`stickers: приоритет — «${name}» (${prio.stateToPriority.size} состояний), меток ${labels.size}`);
      } else {
        this.log.warn(
          `stickers: стикер приоритета не опознан среди ${stickers.length} — у всех задач будет «обычный». ` +
            'Опознаём по названию (приоритет / priority / важн) и по названиям состояний.',
        );
      }
      return { prio, labels, owned: await this.repo.importedLabelIds(connectionId) };
    } catch (e) {
      this.log.warn(`stickers: не загрузились (${(e as Error).message}) — импорт без приоритетов и меток`);
      return { prio: EMPTY_PRIORITY_MAP, labels: new Map(), owned: new Set() };
    }
  }

  private async importTask(
    tenantId: string, connectionId: string, projectId: string, columnId: string,
    t: YgTask, userMap: Map<string, string>, st: StickerCtx,
  ) {
    const assigneeId = (t.assigned ?? []).map((u) => userMap.get(String(u))).find(Boolean) ?? null;
    const createdBy = t.createdBy ? userMap.get(String(t.createdBy)) ?? null : null;
    const deadlineMs = t.deadline?.deadline;
    const deadlineAt = deadlineMs ? new Date(Number(deadlineMs)).toISOString() : null;
    const completed = !!t.completed;
    // YouGile хранит описание разметкой. Без чистки в карточке оказывается
    // «<p>Сделать <strong>до пятницы</strong></p>»: читать нельзя, искать тоже.
    const description = t.description ? htmlToText(t.description).slice(0, 20000) || null : null;
    const priority = priorityFromStickers(st.prio, t.stickers);

    // В YouGile «завершено» — флажок, не зависящий от колонки, поэтому закрытая задача
    // приезжала в свою «Паузу» и висела там с отметкой «завершена». Кладём такие в «Готово»,
    // если колонка есть. Правило детерминированное, поэтому и хеш считаем по итоговой
    // колонке — иначе каждый следующий импорт видел бы расхождение и таскал карточку туда-сюда.
    const placementId = (completed && (await this.repo.doneColumnId(tenantId, projectId))) || columnId;

    const hash = taskStateHash({
      title: t.title, description, localColumnId: placementId,
      assigned: (t.assigned ?? []).map(String), deadlineIso: deadlineAt, completed, priority,
    });
    const { id } = await this.repo.upsertTask({
      tenantId, connectionId, externalId: String(t.id), projectId, columnId: placementId,
      title: (t.title || 'Без названия').slice(0, 255), description,
      assigneeId, createdBy, priority, deadlineAt,
      status: completed ? 'done' : 'todo', closed: completed, hash,
    });

    // Метки из прочих стикеров. Синхронизируем независимо от хеша: смена «Тип задачи»
    // не меняет полей задачи, и по хешу такое изменение было бы не видно.
    if (st.labels.size) {
      const desired: string[] = [];
      for (const l of labelsForTask(st.labels, t.stickers)) {
        const labelId = await this.repo.ensureLabel({ tenantId, connectionId, externalId: l.externalId, name: l.name, color: l.color });
        st.owned.add(labelId);
        desired.push(labelId);
      }
      await this.repo.syncTaskLabels(tenantId, id, desired, st.owned);
    }
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
      // Комментарии в YouGile — тоже HTML: в чате задачи вместо текста были теги.
      const body = htmlToText(m.text).trim();
      // наше же сообщение, отправленное из CRM (E4) — вернулось из YouGile; дубль не заводим
      if (body && await this.repo.getRef(ctx.connectionId, 'chat_echo', chatEchoKey(taskExternalId, body))) continue;
      const external = `${taskExternalId}:${m.id}`;
      if (body && author) {
        const prefix = m.fromUserId && !userMap.get(String(m.fromUserId)) ? '[Импортировано из YouGile]\n' : '';
        const inserted = await this.repo.upsertComment({
          tenantId: ctx.tenantId, connectionId: ctx.connectionId, externalId: external, taskId: localTaskId,
          authorId: author, body: (prefix + body).slice(0, 20000),
          postedAt: messagePostedAt(m),
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
