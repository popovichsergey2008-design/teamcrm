import { Injectable, Logger } from '@nestjs/common';
import { FilesService } from '../../files/files.service';
import { ImportRepository } from '../common/import.repository';
import { TrelloClient, TrCard, TrMember } from './trello.client';
import {
  cardHash, descriptionWithLinks, isCardDone, labelColor, labelNames, priorityFromLabels, projectName,
} from './trello.map';

export interface TrelloImportMsg {
  tenantId: string;
  connectionId: string;
  key: string;
  token: string;
  boardIds: string[];
  runId: string;
  actorId: string | null;
}

interface Stats {
  boards: number; columns: number; tasks: number; updated: number;
  comments: number; attachments: number; checklists: number;
  warnings: string[];
}

/** Больше 25 МБ на вложение не тянем: это уже не переезд задач, а перенос файлопомойки. */
const MAX_ATTACHMENT = 25 * 1024 * 1024;

const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', zip: 'application/zip',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  mp4: 'video/mp4', mov: 'video/quicktime', mp3: 'audio/mpeg',
};
const ctByName = (name: string): string =>
  MIME_BY_EXT[(name.split('.').pop() ?? '').toLowerCase()] ?? 'application/octet-stream';

/**
 * Импорт досок Trello.
 *
 * Списки → колонки, карточки → задачи, чек-листы, метки, комментарии, вложения.
 * Идемпотентно: повторный прогон обновляет, а не удваивает, — это главное требование
 * к любому импорту, потому что первый прогон почти никогда не бывает последним.
 *
 * Что НЕ переносим и почему: историю действий Trello (у нас своя), права доступа
 * (у нас другая модель), автоматизации Butler (их нечем исполнять). Об этом сказано
 * в спеке — обещать перенос того, чего не переносим, нельзя.
 */
@Injectable()
export class TrelloImportService {
  private readonly log = new Logger('TrelloImport');

  constructor(
    private readonly repo: ImportRepository,
    private readonly files: FilesService,
  ) {}

  async run(msg: TrelloImportMsg): Promise<void> {
    const { runId } = msg;
    const stats: Stats = {
      boards: 0, columns: 0, tasks: 0, updated: 0,
      comments: 0, attachments: 0, checklists: 0, warnings: [],
    };
    await this.repo.setRunRunning(runId);
    try {
      const client = new TrelloClient(msg.key, msg.token);

      for (const boardId of msg.boardIds) {
        try {
          await this.importBoard(client, msg, boardId, stats);
        } catch (e) {
          stats.warnings.push(`Доска ${boardId}: ${(e as Error).message}`);
        }
        await this.repo.setRunStats(runId, stats);
      }

      await this.repo.finishRun(runId, 'done', stats);
      this.log.log(`Trello: досок ${stats.boards}, задач ${stats.tasks} (+${stats.updated} обновлено)`);
    } catch (e) {
      await this.repo.finishRun(runId, 'error', stats, (e as Error).message);
      this.log.warn(`Trello import failed: ${(e as Error).message}`);
    }
  }

  private async importBoard(client: TrelloClient, msg: TrelloImportMsg, boardId: string, stats: Stats) {
    const { tenantId, connectionId } = msg;
    const [boards, lists, members, cards, comments] = await Promise.all([
      client.boards(), client.lists(boardId), client.members(boardId), client.cards(boardId), client.comments(boardId),
    ]);
    const board = boards.find((b) => String(b.id) === String(boardId));
    if (!board) throw new Error('доска недоступна по этому токену');

    const project = await this.repo.upsertProject({
      tenantId, connectionId, externalId: String(board.id), name: projectName(board.name), origin: 'trello',
    });
    stats.boards++;

    // Списки → колонки. Архивные списки Trello тоже создаём: в них лежат карточки,
    // и без колонки им некуда приехать.
    const columnByList = new Map<string, string>();
    const ordered = [...lists].sort((a, b) => Number(a.pos) - Number(b.pos));
    for (let i = 0; i < ordered.length; i++) {
      const id = await this.repo.upsertColumn({
        tenantId, connectionId, projectId: project.id,
        externalId: String(ordered[i].id), name: (ordered[i].name || 'Список').slice(0, 80), position: i,
      });
      columnByList.set(String(ordered[i].id), id);
      stats.columns++;
    }
    const fallbackColumn = await this.repo.ensureFallbackColumn(tenantId, project.id);

    const people = await this.peopleMap(msg, members);
    const commentsByCard = new Map<string, typeof comments>();
    for (const c of comments) {
      const cardId = String((c as any).data?.card?.id ?? '');
      if (!cardId) continue;
      const arr = commentsByCard.get(cardId) ?? [];
      arr.push(c);
      commentsByCard.set(cardId, arr);
    }

    for (const card of cards) {
      try {
        const taskId = await this.importCard(client, msg, {
          card, projectId: project.id, columnId: columnByList.get(String(card.idList)) ?? fallbackColumn,
          people, stats,
        });
        if (!taskId) continue;
        for (const c of commentsByCard.get(String(card.id)) ?? []) {
          const body = String((c as any).data?.text ?? '').trim();
          if (!body) continue;
          const author = people.get(String(c.idMemberCreator)) ?? msg.actorId;
          if (!author) continue; // без автора комментарий писать некуда
          const added = await this.repo.upsertComment({
            tenantId, connectionId, externalId: String(c.id), taskId,
            authorId: author, body, postedAt: c.date ?? null,
          });
          if (added) stats.comments++;
        }
      } catch (e) {
        stats.warnings.push(`Карточка «${card.name}»: ${(e as Error).message}`);
      }
    }
  }

  private async importCard(
    client: TrelloClient,
    msg: TrelloImportMsg,
    ctx: {
      card: TrCard; projectId: string; columnId: string;
      people: Map<string, string>; stats: Stats;
    },
  ): Promise<string | null> {
    const { tenantId, connectionId } = msg;
    const { card, stats } = ctx;

    // Исполнитель — первый из назначенных: у нас исполнитель один, остальные пойдут
    // соисполнителями смысла ради, но в v1 честнее взять первого и сказать об этом.
    const assignee = (card.idMembers ?? []).map((m) => ctx.people.get(String(m))).find(Boolean) ?? null;

    const uploads = (card.attachments ?? []).filter((a) => a.isUpload);
    const links = (card.attachments ?? []).filter((a) => !a.isUpload).map((a) => ({ name: a.name, url: a.url }));

    const hash = cardHash(card, assignee ?? null);
    const done = isCardDone(card);
    const task = await this.repo.upsertTask({
      tenantId, connectionId, externalId: String(card.id),
      projectId: ctx.projectId, columnId: ctx.columnId,
      title: (card.name || 'Без названия').slice(0, 255),
      description: descriptionWithLinks(card.desc ?? '', links) || null,
      assigneeId: assignee ?? null,
      createdBy: msg.actorId,
      priority: priorityFromLabels(card.labels ?? []),
      deadlineAt: card.due ?? null,
      status: done ? 'done' : 'open',
      closed: done,
      hash,
    });
    if (task.created) stats.tasks++;
    else if (task.changed) stats.updated++;
    if (!task.changed) return task.id; // ничего не менялось — не трогаем ни метки, ни файлы

    const names = labelNames(card.labels ?? []);
    if (names.length) {
      const ids: string[] = [];
      for (const name of names) {
        const color = labelColor((card.labels ?? []).find((l) => (l.name ?? '').trim() === name)?.color ?? null);
        ids.push(await this.repo.ensureLabel(tenantId, name, color));
      }
      await this.repo.setTaskLabels(tenantId, task.id, ids);
    }

    const items = (card.checklists ?? []).flatMap((cl) => (cl.checkItems ?? [])
      .sort((a, b) => Number(a.pos) - Number(b.pos))
      .map((it) => ({
        // Название чек-листа сохраняем в тексте пунктов: у нас чек-лист один на задачу,
        // а в Trello их бывает несколько, и без пометки пункты смешиваются в кашу.
        text: (card.checklists ?? []).length > 1 ? `${cl.name}: ${it.name}` : it.name,
        done: it.state === 'complete',
      })));
    if (items.length) {
      await this.repo.replaceChecklist(tenantId, task.id, items);
      stats.checklists++;
    }

    for (const a of uploads) {
      if (await this.repo.getRef(connectionId, 'file', String(a.id))) continue; // уже переносили
      if ((a.bytes ?? 0) > MAX_ATTACHMENT) {
        stats.warnings.push(`Файл «${a.name}» больше 25 МБ — не перенесён`);
        continue;
      }
      try {
        const buffer = await client.download(a.url);
        const uploaded = await this.files.upload({
          tenantId, userId: msg.actorId ?? '', buffer, fileName: a.name || 'file',
          contentType: a.mimeType || ctByName(a.name || ''), ownerKind: 'task_attachment', ownerId: task.id,
        });
        await this.repo.addAttachment({
          tenantId, connectionId, externalFileId: String(a.id), taskId: task.id, fileId: uploaded.id,
        });
        stats.attachments++;
      } catch (e) {
        stats.warnings.push(`Файл «${a.name}»: ${(e as Error).message}`);
      }
    }

    return task.id;
  }

  /**
   * Участники доски → наши сотрудники.
   *
   * Порядок: ручная привязка → почта → полное имя в любом порядке слов. Почты в Trello
   * почти никогда нет (API её не отдаёт для чужих участников), поэтому имя здесь не
   * запасной, а основной путь. Не опознанного человека не выдумываем: карточка приедет
   * без исполнителя, а он сам — в список «привязать руками».
   */
  private async peopleMap(msg: TrelloImportMsg, members: TrMember[]): Promise<Map<string, string>> {
    const [manual, byEmail, byName] = await Promise.all([
      this.repo.userRefs(msg.connectionId),
      this.repo.userEmailMap(msg.tenantId),
      this.repo.userNameMap(msg.tenantId),
    ]);
    const out = new Map<string, string>();
    for (const m of members) {
      const ext = String(m.id);
      const manualHit = manual.get(ext);
      if (manualHit) { out.set(ext, manualHit); continue; }
      const email = (m.email ?? '').toLowerCase();
      const emailHit = email ? byEmail.get(email) : undefined;
      if (emailHit) { out.set(ext, emailHit); continue; }
      const key = String(m.fullName ?? '').toLowerCase().split(/\s+/).filter(Boolean).sort().join(' ');
      const nameHit = key ? byName.get(key) : undefined;
      if (nameHit) out.set(ext, nameHit);
    }
    return out;
  }
}
