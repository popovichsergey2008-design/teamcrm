import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Readable } from 'stream';
import { FilesService } from '../../files/files.service';
import { IntegrationCryptoService } from '../crypto.service';
import { ConnectionRow, OutboxRow, PushTaskRow, YougileRepository } from './yougile.repository';
import { YgTaskWrite, YougileClient, YougileError } from './yougile.client';
import { chatEchoKey, taskStateHash } from './yougile.hash';

const BATCH = 10;
const MAX_ATTEMPTS = 6;

/** Контекст одного подключения на время прохода очереди (клиент + ленивый список юзеров YouGile). */
interface Ctx {
  conn: ConnectionRow;
  client: YougileClient;
  users?: Map<string, string>; // e-mail (lower) → id пользователя YouGile
}

async function toBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c));
  return Buffer.concat(chunks);
}

/**
 * E4 — выгрузка изменений CRM → YouGile.
 *
 * Читает очередь integration_outbox (её наполняют доменные сервисы через IntegrationOutboxService),
 * дотягивает АКТУАЛЬНОЕ состояние объекта из БД и отправляет его в YouGile. Ленивое чтение
 * состояния делает операции идемпотентными: несколько правок подряд схлопываются в одну отправку.
 *
 * Порядок в очереди (по id) сохраняется — важно, когда создание задачи должно опередить её перенос.
 */
@Injectable()
export class YougileOutboundService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('YougileOutbound');
  private timer?: NodeJS.Timeout;
  private busy = false;

  constructor(
    private readonly repo: YougileRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly files: FilesService,
  ) {}

  onModuleInit() {
    if (process.env.YOUGILE_PUSH_DISABLED === '1') return;
    void this.repo.outboxRequeueStuck().catch(() => undefined); // упали в прошлый раз на середине
    const ms = Math.max(200, Number(process.env.YOUGILE_PUSH_INTERVAL_MS ?? 2000));
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.(); // не держим процесс (тесты/CLI)
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Один проход очереди. Публичный — тесты и ручной «протолкнуть очередь» зовут напрямую. */
  async tick(): Promise<number> {
    if (this.busy) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const rows = await this.repo.claimOutbox(BATCH);
      const ctxs = new Map<string, Ctx | null>();
      for (const row of rows) {
        try {
          if (!ctxs.has(row.connection_id)) ctxs.set(row.connection_id, await this.context(row.connection_id));
          const ctx = ctxs.get(row.connection_id) ?? null;
          if (!ctx) { await this.repo.outboxDone(row.id); continue; } // выгрузку выключили — снимаем задание
          await this.dispatch(ctx, row);
          await this.repo.outboxDone(row.id);
          sent++;
        } catch (e) {
          await this.fail(row, e);
        }
      }
    } catch (e) {
      this.log.warn(`outbox tick failed: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
    return sent;
  }

  private async context(connectionId: string): Promise<Ctx | null> {
    const conn = await this.repo.connectionById(connectionId);
    if (!conn || !conn.is_active || !conn.push_enabled || conn.provider !== 'yougile') return null;
    return { conn, client: new YougileClient(this.crypto.decrypt(conn.webhook_enc)) };
  }

  private dispatch(ctx: Ctx, row: OutboxRow): Promise<unknown> {
    switch (row.kind) {
      case 'task.create':
      case 'task.update':
      case 'task.move':
        return this.pushTask(ctx, row.tenant_id, row.local_id);
      case 'comment.create':
        return this.pushComment(ctx, row);
      case 'attachment.create':
        return this.pushAttachment(ctx, row);
      case 'column.create':
      case 'column.rename':
        return this.pushColumn(ctx, row);
      case 'column.delete':
        return this.pushColumnDelete(ctx, row);
      default:
        throw new YougileError('BAD_REQUEST', `неизвестный тип операции: ${row.kind}`);
    }
  }

  /** Разбор ошибки: что бессмысленно повторять (ключ/тело/маппинг) — гасим сразу, остальное с бэкоффом. */
  private async fail(row: OutboxRow, e: unknown) {
    const msg = (e as Error)?.message ?? String(e);
    const code = e instanceof YougileError ? e.code : '';
    const terminal = code === 'AUTH' || code === 'BAD_REQUEST' || code === 'MAP' || row.attempts >= MAX_ATTEMPTS;
    if (terminal) this.log.warn(`outbox ${row.kind} #${row.id} остановлено: ${msg}`);
    await this.repo.outboxFail(row.id, msg, terminal ? null : Math.min(600, 5 * 2 ** row.attempts));
  }

  // ───── задачи ─────

  /** Создаёт или обновляет задачу в YouGile по текущему состоянию CRM. Возвращает внешний id. */
  private async pushTask(ctx: Ctx, tenantId: string, taskId: string): Promise<string | null> {
    const task = await this.repo.taskForPush(tenantId, taskId);
    if (!task) return null; // задача исчезла локально — выгружать нечего
    const columnId = await this.ensureColumn(ctx, tenantId, task.column_id);
    const assigned = await this.resolveAssigned(ctx, tenantId, task);
    const deadlineIso = task.deadline_at ? new Date(task.deadline_at).toISOString() : null;
    const completed = !!task.closed_at;

    const body: YgTaskWrite = {
      title: task.title,
      description: task.description ?? '',
      columnId,
      completed,
    };
    if (assigned) body.assigned = assigned;
    if (deadlineIso) body.deadline = { deadline: new Date(deadlineIso).getTime(), withTime: true };

    const ref = await this.repo.refByLocal(ctx.conn.id, 'task', taskId);
    let externalId: string;
    if (ref) {
      await this.writeTask((b) => ctx.client.updateTask(ref.external_id, b), body);
      externalId = ref.external_id;
    } else {
      const res = await this.writeTask((b) => ctx.client.createTask(b), body);
      if (!res?.id) throw new YougileError('HTTP', 'YouGile не вернул id созданной задачи');
      externalId = String(res.id);
    }

    // Защита от эха: если известно ВСЁ отправленное состояние — записываем ожидаемый хеш,
    // и входящий вебхук о нашей же правке не тронет карточку. Иначе хеш сбрасываем:
    // ответное событие просто перечитает задачу из YouGile (лишняя, но безопасная запись).
    const hash = assigned ? taskStateHash({
      title: task.title, description: task.description, localColumnId: task.column_id,
      assigned, deadlineIso, completed,
    }) : null;
    await this.repo.putRef({ tenantId, connectionId: ctx.conn.id, entityType: 'task', externalId, localId: taskId, hash });
    return externalId;
  }

  /** Часть аккаунтов не принимает срок в теле — тогда повторяем запрос без него, чтобы не терять правку. */
  private async writeTask<T>(fn: (b: YgTaskWrite) => Promise<T>, body: YgTaskWrite): Promise<T> {
    try {
      return await fn(body);
    } catch (e) {
      if (e instanceof YougileError && e.code === 'BAD_REQUEST' && body.deadline) {
        const { deadline, ...rest } = body;
        void deadline;
        this.log.warn('YouGile не принял поле deadline — отправляю задачу без срока');
        return await fn(rest);
      }
      throw e;
    }
  }

  /**
   * Исполнитель CRM → массив assigned YouGile.
   * `[]` — исполнителя сняли (это надо передать), `undefined` — сопоставить не удалось,
   * тогда поле не отправляем вовсе, чтобы не затереть исполнителя на стороне YouGile.
   */
  private async resolveAssigned(ctx: Ctx, tenantId: string, task: PushTaskRow): Promise<string[] | undefined> {
    if (!task.assignee_id) return [];
    const ref = await this.repo.refByLocal(ctx.conn.id, 'user', task.assignee_id);
    if (ref) return [ref.external_id];
    const email = (await this.repo.userEmail(tenantId, task.assignee_id))?.email;
    if (!email) return undefined;
    if (!ctx.users) {
      const list = await ctx.client.listUsers();
      ctx.users = new Map(list.filter((u) => u.email).map((u) => [u.email!.toLowerCase(), String(u.id)]));
    }
    const externalId = ctx.users.get(email.toLowerCase());
    if (!externalId) return undefined; // такого сотрудника в YouGile нет
    await this.repo.putRef({ tenantId, connectionId: ctx.conn.id, entityType: 'user', externalId, localId: task.assignee_id });
    return [externalId];
  }

  // ───── колонки ─────

  /** Внешний id колонки; если колонку завели уже в CRM — создаём её в YouGile на связанной доске. */
  private async ensureColumn(ctx: Ctx, tenantId: string, columnId: string): Promise<string> {
    const ref = await this.repo.refByLocal(ctx.conn.id, 'column', columnId);
    if (ref) return ref.external_id;
    const col = await this.repo.columnForPush(tenantId, columnId);
    if (!col) throw new YougileError('MAP', 'колонка не найдена');
    const board = await this.repo.refByLocal(ctx.conn.id, 'project', col.project_id);
    if (!board) throw new YougileError('MAP', 'проект не связан с доской YouGile');
    const res = await ctx.client.createColumn({ title: col.name, boardId: board.external_id });
    if (!res?.id) throw new YougileError('HTTP', 'YouGile не вернул id созданной колонки');
    await this.repo.putRef({ tenantId, connectionId: ctx.conn.id, entityType: 'column', externalId: String(res.id), localId: columnId });
    return String(res.id);
  }

  private async pushColumn(ctx: Ctx, row: OutboxRow) {
    const col = await this.repo.columnForPush(row.tenant_id, row.local_id);
    if (!col) return;
    const ref = await this.repo.refByLocal(ctx.conn.id, 'column', col.id);
    if (!ref) { await this.ensureColumn(ctx, row.tenant_id, col.id); return; }
    await ctx.client.updateColumn(ref.external_id, { title: col.name });
  }

  private async pushColumnDelete(ctx: Ctx, row: OutboxRow) {
    const ref = await this.repo.refByLocal(ctx.conn.id, 'column', row.local_id);
    if (!ref) return; // колонки в YouGile и не было
    await ctx.client.updateColumn(ref.external_id, { deleted: true });
    await this.repo.deleteRef(ctx.conn.id, 'column', ref.external_id);
  }

  // ───── чат задачи: комментарии и файлы ─────

  private async ensureTask(ctx: Ctx, tenantId: string, taskId: string): Promise<string> {
    const ref = await this.repo.refByLocal(ctx.conn.id, 'task', taskId);
    if (ref) return ref.external_id;
    const created = await this.pushTask(ctx, tenantId, taskId);
    if (!created) throw new YougileError('MAP', 'задача не найдена');
    return created;
  }

  private async pushComment(ctx: Ctx, row: OutboxRow) {
    const c = await this.repo.commentForPush(row.tenant_id, row.local_id);
    if (!c) return;
    const taskExternalId = await this.ensureTask(ctx, row.tenant_id, c.task_id);
    // все сообщения уходят от владельца API-ключа, поэтому автора подписываем в тексте
    const text = (c.author_name ? `${c.author_name}: ` : '') + c.body;
    const res = await ctx.client.sendMessage(taskExternalId, text);
    await this.markOwnMessage(ctx, row.tenant_id, taskExternalId, text, c.task_id, { commentId: c.id, messageId: res?.id });
  }

  private async pushAttachment(ctx: Ctx, row: OutboxRow) {
    const a = await this.repo.attachmentForPush(row.tenant_id, row.local_id);
    if (!a) return;
    const taskExternalId = await this.ensureTask(ctx, row.tenant_id, a.task_id);
    const { stream } = await this.files.getForDownload(row.tenant_id, a.file_id);
    const up = await ctx.client.uploadFile(await toBuffer(stream), a.file_name, a.content_type || 'application/octet-stream');
    // API чата не принимает вложения в теле сообщения — отправляем ссылку на загруженный файл
    const text = `📎 ${a.file_name}${up.url ? `\n${up.url}` : ''}`;
    const res = await ctx.client.sendMessage(taskExternalId, text);
    await this.markOwnMessage(ctx, row.tenant_id, taskExternalId, text, a.task_id, { messageId: res?.id });
  }

  /**
   * Помечает отправленное нами сообщение, чтобы обратный импорт чата не создал из него дубль:
   * ключ по тексту (`chat_echo`) ловит эхо всегда, ключ по id сообщения — когда YouGile его вернул.
   */
  private async markOwnMessage(
    ctx: Ctx, tenantId: string, taskExternalId: string, text: string, localTaskId: string,
    ids: { commentId?: string; messageId?: string | number },
  ) {
    const base = { tenantId, connectionId: ctx.conn.id };
    await this.repo.putRef({ ...base, entityType: 'chat_echo', externalId: chatEchoKey(taskExternalId, text), localId: localTaskId });
    if (ids.messageId != null && ids.commentId) {
      await this.repo.putRef({ ...base, entityType: 'comment', externalId: `${taskExternalId}:${ids.messageId}`, localId: ids.commentId });
    }
  }
}
