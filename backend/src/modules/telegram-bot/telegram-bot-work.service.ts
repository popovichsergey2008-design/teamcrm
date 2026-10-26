import { HttpException, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiService } from '../ai/ai.service';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { isShortCommand } from '../nl/fast-path';
import { NlService } from '../nl/nl.service';
import { taskTitleFrom } from '../nl/task-draft';
import { InboxRepository } from '../notifications/inbox.repository';
import { MIRROR_EVENT_KEY } from '../notifications/mail.templates';
import { NotificationsService } from '../notifications/notifications.service';
import { StandupService } from '../standup/standup.service';
import { TasksService } from '../tasks/tasks.service';
import { TgAccount } from '../telegram/telegram.repository';
import { TelegramSender } from '../telegram/telegram.sender';
import { TelegramService } from '../telegram/telegram.service';
import {
  canCancel, focusDue, focusText, forwardedCommand, forwardFrom, isForwarded, moveOfferDue, staffIntent, taskCardText,
  TASK_VOICE_MAX_SECONDS,
} from './bot-work-rules';
import * as T from './bot-texts';
import { TelegramBotRepository } from './telegram-bot.repository';
import { TelegramBotWorkRepository } from './telegram-bot-work.repository';

const TICK_MS = 60_000;

interface Own { tenantId: string; userId: string }
interface Input { text?: string; voice?: { fileId: string; duration: number }; forwarded?: boolean; from?: string | null }

/**
 * Рабочий Telegram-бот для команды (#4619, этап 4; ТЗ: «Постоянный ИИ-секретарь
 * руководителя в кармане» и «Как бот дожимает в продажу и удерживает команду»).
 *
 * — Пересланное сообщение, голос или текст привязанного сотрудника → задача на доску
 *   авто-постановкой (#4615) от его имени; дейлик не ломаем (правило — staffIntent).
 * — Сдача работы на проверку → постановщику в бот «Принять работу / Вернуть на доработку».
 * — «Фокус дня» в 09:30 руководителю — три строки.
 * — На 4-й день пробного периода, если досок не переносили, — предложение переезда.
 */
@Injectable()
export class TelegramBotWorkService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('TelegramBotWork');
  private readonly base: string;
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(
    config: ConfigService,
    private readonly work: TelegramBotWorkRepository,
    private readonly bot: TelegramBotRepository,
    private readonly telegram: TelegramService,
    private readonly sender: TelegramSender,
    private readonly standup: StandupService,
    private readonly nl: NlService,
    private readonly ai: AiService,
    private readonly tasks: TasksService,
    private readonly notify: NotificationsService,
    private readonly inbox: InboxRepository,
  ) {
    this.base = (config.get<string>('APP_BASE_URL') || 'https://app.qevo.one').replace(/\/+$/, '');
  }

  onModuleInit(): void {
    // сдача на проверку: одно сообщение с кнопками вместо копии письма
    this.notify.onApprovalRequested((tenantId, taskId, actorId) => this.approvalRequested(tenantId, taskId, actorId));
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await this.focusTick();
      await this.moveTick();
    } catch (e) {
      this.log.warn(`проход: ${(e as Error).message}`);
    } finally {
      this.busy = false;
    }
  }

  // ───────────── сообщение привязанного сотрудника ─────────────

  async onStaffMessage(update: any, actor: TgAccount): Promise<void> {
    const msg = update?.message;
    // группы — как раньше, дейликом: задачи из общего чата от чужого имени не ставим
    if (msg?.chat?.type && msg.chat.type !== 'private') return this.standup.handleTelegramUpdate(update);
    const tgId = String(msg.from.id);
    const chatId = String(msg.chat?.id ?? tgId);
    const own: Own = { tenantId: String(actor.tenant_id), userId: String(actor.user_id) };

    // клиент по ссылке с итогами встречи (#1525) — его ответы первыми, как в дейлике
    if (typeof msg.text === 'string') {
      const name = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || null;
      if (await this.telegram.handleExternal(chatId, msg.text, { staff: true, name })) return;
    }

    const intent = staffIntent(msg, await this.work.state(tgId));
    switch (intent.kind) {
      case 'standup':
      case 'daily':
        return this.standup.handleTelegramUpdate(update);
      case 'daily_cmd':
        await this.work.setMode(tgId, 'daily');
        if (intent.rest) return this.standup.handleTelegramUpdate({ ...update, message: { ...msg, text: intent.rest } });
        return this.say(chatId, { text: T.DAILY_MODE });
      case 'task_cmd':
        await this.work.setMode(tgId, 'task');
        if (intent.rest) return this.makeTask(own, chatId, { text: intent.rest });
        return this.say(chatId, { text: T.TASK_MODE });
      case 'task':
        return this.makeTask(own, chatId, inputOf(msg));
      case 'return_reason':
        return this.returnWithReason(tgId, chatId, own, intent.text);
      case 'ask': {
        const n = await this.work.pushAsk(tgId, slim(msg));
        // серия: спрашиваем один раз, кнопка разложит всё накопленное
        if (n <= 1) return this.say(chatId, T.askTaskOrDaily());
        return;
      }
    }
  }

  /** Кнопки рабочего бота. false — не наша кнопка. */
  async onButton(tgId: string, chatId: string, action: string, arg: string, cbMessageId: number | null): Promise<boolean> {
    if (!['tq', 'dq', 'ux', 'ap', 'rw'].includes(action)) return false;
    const actor = await this.telegram.resolveActor(tgId);
    if (!actor) { await this.say(chatId, { text: T.NO_SPACE }); return true; }
    const own: Own = { tenantId: String(actor.tenant_id), userId: String(actor.user_id) };
    const id = /^\d{1,18}$/.test(arg) ? arg : '';
    switch (action) {
      case 'tq': return this.pickTask(tgId, chatId, own).then(() => true);
      case 'dq': return this.pickDaily(tgId, chatId).then(() => true);
      case 'ux': return this.cancel(chatId, own, id).then(() => true);
      case 'ap': return this.approve(chatId, own, id, cbMessageId).then(() => true);
      case 'rw': return this.askReason(tgId, chatId, own, id).then(() => true);
    }
    return false;
  }

  private async pickTask(tgId: string, chatId: string, own: Own): Promise<void> {
    const items = await this.work.take(tgId, 'ask');
    await this.work.setMode(tgId, 'task');
    if (!Array.isArray(items) || !items.length) return this.say(chatId, { text: T.ASK_EXPIRED });
    for (const m of items) await this.makeTask(own, chatId, inputOf(m));
  }

  private async pickDaily(tgId: string, chatId: string): Promise<void> {
    const items = await this.work.take(tgId, 'ask');
    await this.work.setMode(tgId, 'daily');
    if (!Array.isArray(items) || !items.length) return this.say(chatId, { text: T.ASK_EXPIRED });
    // прежний путь дейлика: тот же message_id — и та же защита от повтора
    for (const m of items) await this.standup.handleTelegramUpdate({ message: m });
  }

  // ───────────── пересылка / голос / текст → задача ─────────────

  private async makeTask(own: Own, chatId: string, input: Input): Promise<void> {
    this.typing(chatId);
    let text = (input.text ?? '').trim();
    let voice = false;
    if (input.voice) {
      if (input.voice.duration > TASK_VOICE_MAX_SECONDS) return this.say(chatId, { text: T.TASK_VOICE_TOO_LONG });
      const audio = await this.sender.fileBuffer(input.voice.fileId);
      const hint = await this.nl.speechHint(own.tenantId).catch(() => undefined);
      // #4666: короткое поручение — быстрой моделью распознавания
      const heard = audio
        ? await this.ai.transcribeAudio(own.tenantId, audio, 'voice.ogg', hint, { fast: true }).catch(() => '')
        : '';
      audio?.fill(0); // звук не храним: остаётся только расшифровка в задаче
      text = (heard || '').trim();
      if (!text) return this.say(chatId, { text: T.TASK_VOICE_FAILED });
      voice = true;
    }
    if (text.length < 3) return this.say(chatId, { text: T.TASK_NOT_PARSED });
    // пересланное — данные, не указания: в модель уходит в рамке (маскирование ПД — в AiService)
    const command = input.forwarded ? forwardedCommand(text, input.from ?? null) : text;

    let drafts: any[];
    try {
      drafts = await this.nl.parseMany(own.tenantId, own.userId, command, null, {
        auto: true, fast: !input.forwarded && isShortCommand(command),
      });
    } catch (e) {
      this.log.warn(`разбор поручения: ${(e as Error).message}`);
      return this.say(chatId, { text: T.TASK_NOT_PARSED });
    }
    const list = drafts.filter((d) => d?.intent === 'create_task' && d.task?.title).slice(0, 3);
    if (!list.length) return this.say(chatId, { text: T.TASK_NOT_PARSED });

    const tz = await this.work.tzOf(own.tenantId, own.userId);
    for (const d of list) {
      const projectId = d.task.projectId ?? (await this.work.onlyProject(own.tenantId));
      if (!projectId) { await this.say(chatId, { text: T.TASK_NO_PROJECT }); continue; }
      const tagIds = (d.task.autoTags ?? []).map((x: { id: string }) => String(x.id));
      // без модели название собирают правила — из рамки «по пересланному сообщению»; берём само сообщение
      const title = input.forwarded && /пересланн/i.test(String(d.task.title)) ? taskTitleFrom(text).slice(0, 120) : d.task.title;
      const quoted = input.forwarded
        ? `Пересланное сообщение${input.from ? ` от ${input.from}` : ''}:\n«${text.slice(0, 3000)}»`
        : null;
      try {
        const res: any = await this.nl.apply(own.tenantId, own.userId, {
          intent: 'create_task',
          task: {
            ...d.task, title, projectId, auto: true, voice, tagIds, suggestedTagIds: tagIds,
            checklist: (d.task.checklist ?? []).map((x: string) => String(x).trim()).filter(Boolean),
            description: [d.task.description, quoted].filter(Boolean).join('\n\n') || undefined,
          },
        }, { confirm: 'telegram' });
        const id = String(res.task.id);
        const card = await this.work.taskCard(own.tenantId, id);
        await this.say(chatId, {
          text: taskCardText({
            title: card?.title ?? res.task.title, assignee: card?.assignee_name ?? null,
            deadline: card?.deadline_at ?? null, project: card?.project_name ?? '', tz,
          }),
          markup: T.taskButtons(id, this.base),
        });
      } catch (e) {
        const human = e instanceof HttpException && e.getStatus() < 500;
        if (!human) this.log.warn(`задача из Telegram: ${(e as Error).message}`);
        await this.say(chatId, { text: human ? (e as Error).message : T.SOMETHING_WRONG });
      }
    }
  }

  /** «Отменить» под карточкой: своя задача, первые 10 минут — в корзину. */
  private async cancel(chatId: string, own: Own, taskId: string): Promise<void> {
    const card = taskId ? await this.work.taskCard(own.tenantId, taskId) : null;
    if (!card) return this.say(chatId, { text: T.TASK_GONE });
    if (!canCancel({ createdBy: card.created_by, createdAt: card.created_at }, own.userId)) {
      return this.say(chatId, { text: T.TASK_CANCEL_LATE });
    }
    const role = (await this.bot.roleOf(own.tenantId, own.userId))?.role_code ?? 'member';
    try {
      await this.tasks.removeByPerson(own.tenantId, taskId, { userId: own.userId, role }, { reason: 'Отменено в Telegram-боте' });
      return this.say(chatId, { text: T.TASK_CANCELLED });
    } catch (e) {
      return this.say(chatId, { text: this.why(e) });
    }
  }

  // ───────────── «Принять работу / Вернуть на доработку» ─────────────

  /**
   * Работа сдана: постановщику, привязавшему Telegram, — сообщение с двумя кнопками.
   * Возвращает, кому оно ушло: им копию письма о сдаче в Telegram не дублируем.
   * Те же выключатели, что у копий писем: «о смене статуса» и «дублировать в Telegram»,
   * и тишина глубокой работы.
   */
  async approvalRequested(tenantId: string, taskId: string, actorId: string | null): Promise<string[]> {
    if (!this.sender.enabled) return [];
    try {
      const d = await this.work.decider(tenantId, taskId, actorId);
      if (!d) return [];
      const [mirror, status, quiet, card] = await Promise.all([
        this.work.prefOn(tenantId, d.user_id, MIRROR_EVENT_KEY),
        this.work.prefOn(tenantId, d.user_id, 'task.status'),
        this.inbox.isQuiet(tenantId, d.user_id).catch(() => false),
        this.work.taskCard(tenantId, taskId),
      ]);
      if (!mirror || !status || quiet || !card) return [];
      const ok = await this.send(d.chat_id, T.approvalAsk({
        taskId, title: card.title, who: card.assignee_name, project: card.project_name, base: this.base,
      }));
      return ok ? [d.user_id] : [];
    } catch (e) {
      this.log.warn(`сдача ${taskId} в Telegram: ${(e as Error).message}`);
      return [];
    }
  }

  private async approve(chatId: string, own: Own, taskId: string, cbMessageId: number | null): Promise<void> {
    if (!taskId) return this.say(chatId, { text: T.TASK_GONE });
    const role = (await this.bot.roleOf(own.tenantId, own.userId))?.role_code ?? 'member';
    try {
      // права — те же, что у REST: решает постановщик или владелец (tasks.approve)
      const t = await this.tasks.approve(own.tenantId, taskId, { userId: own.userId, role });
      this.dropButtons(chatId, cbMessageId);
      return this.say(chatId, { text: T.approved(t.title) });
    } catch (e) {
      return this.say(chatId, { text: this.why(e) });
    }
  }

  /** «Вернуть»: сначала проверяем право, потом просим причину ответом. */
  private async askReason(tgId: string, chatId: string, own: Own, taskId: string): Promise<void> {
    const card = taskId ? await this.work.taskCard(own.tenantId, taskId) : null;
    if (!card) return this.say(chatId, { text: T.TASK_GONE });
    if (card.approval_state !== 'pending') return this.say(chatId, { text: T.NOT_PENDING });
    const role = (await this.bot.roleOf(own.tenantId, own.userId))?.role_code ?? 'member';
    if (String(card.created_by ?? '') !== own.userId && role !== 'owner') return this.say(chatId, { text: T.NOT_YOURS });
    await this.work.setReturn(tgId, own.tenantId, taskId);
    await this.sender.call('sendMessage', {
      chat_id: chatId, text: `${T.RETURN_ASK}\n«${card.title}»`.slice(0, 4096),
      reply_markup: { force_reply: true, input_field_placeholder: 'Что доработать' },
    });
  }

  private async returnWithReason(tgId: string, chatId: string, own: Own, reason: string): Promise<void> {
    const p = await this.work.take(tgId, 'return');
    if (!p?.taskId || String(p.tenantId) !== own.tenantId) return this.say(chatId, { text: T.ASK_EXPIRED });
    const role = (await this.bot.roleOf(own.tenantId, own.userId))?.role_code ?? 'member';
    try {
      const t = await this.tasks.returnForRework(own.tenantId, String(p.taskId), { userId: own.userId, role }, reason.slice(0, 2000));
      return this.say(chatId, { text: T.returned(t.title) });
    } catch (e) {
      return this.say(chatId, { text: this.why(e) });
    }
  }

  // ───────────── «Фокус дня» в 09:30 ─────────────

  /**
   * Руководителям с привязанным Telegram — в 09:30 по их поясу, раз в день, по будням.
   * Если утренний голосовой бриф (09:00) сегодня уже пришёл в Telegram — фокус не шлём:
   * второе утреннее сообщение о том же — шум (решение 26.10).
   */
  async focusTick(now = new Date()): Promise<number> {
    let sent = 0;
    for (const r of await this.work.focusCandidates()) {
      const l = localParts(now, r.tz);
      if (!focusDue(l)) continue;
      if (await this.work.morningInTelegram(r.user_id, l.date)) continue;
      if (!(await this.work.claimFocus(r.user_id, l.date))) continue;
      try {
        const dayStart = zonedTime(l.date, '00:00', r.tz);
        const dayEnd = zonedTime(tomorrowOf(now, r.tz), '00:00', r.tz);
        const f = await this.work.focusFacts(r.tenant_id, r.user_id, dayStart, dayEnd, now);
        const text = focusText({
          top: f.top, topTotal: f.topTotal, risk: f.risk,
          meetings: f.meetings.map((m) => {
            const p = localParts(new Date(m.starts_at), r.tz);
            return { time: `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`, title: m.title };
          }),
        });
        if (await this.send(r.chat_id, T.focusMessage(text, this.base))) sent += 1;
      } catch (e) {
        // не получилось — освобождаем день: следующий проход попробует снова
        await this.work.releaseFocus(r.user_id, l.date).catch(() => undefined);
        this.log.warn(`фокус ${r.user_id}: ${(e as Error).message}`);
      }
    }
    return sent;
  }

  // ───────────── переезд на 4-й день ─────────────

  /** Владельцу — одно сообщение на организацию; кнопка ведёт в тот же поток заявки (b:mv). */
  async moveTick(now = new Date()): Promise<number> {
    let sent = 0;
    for (const r of await this.work.moveCandidates(now)) {
      const due = moveOfferDue({
        startedAt: r.started_at, now, localHour: localParts(now, r.tz).hour,
        imported: !!r.imported, planLead: !!r.plan_lead, sent: false,
      });
      if (!due) continue;
      if (!(await this.work.claimMoveOffer(r.tenant_id))) continue;
      if (await this.send(r.chat_id, T.moveOffer())) sent += 1;
    }
    return sent;
  }

  // ───────────── отправка ─────────────

  private why(e: unknown): string {
    if (e instanceof HttpException) {
      const s = e.getStatus();
      if (s === 403) return T.NOT_YOURS;
      if (s === 404) return T.TASK_GONE;
      if (s === 409) return T.NOT_PENDING;
      if (s < 500) return e.message;
    }
    this.log.warn(`действие в Telegram: ${(e as Error).message}`);
    return T.SOMETHING_WRONG;
  }

  private async say(chatId: string, m: { text: string; markup?: T.Keyboard }): Promise<void> {
    await this.send(chatId, m);
  }

  /** Отправить и узнать, дошло ли (null от Telegram — нет). */
  private async send(chatId: string, m: { text: string; markup?: T.Keyboard }): Promise<boolean> {
    const r = await this.sender.call('sendMessage', {
      chat_id: chatId, text: m.text.slice(0, 4096),
      ...(m.markup ? { reply_markup: m.markup } : {}),
      link_preview_options: { is_disabled: true },
    });
    return r !== null;
  }

  /** Решение принято — кнопки под сообщением о сдаче больше не нужны. */
  private dropButtons(chatId: string, messageId: number | null): void {
    if (!messageId) return;
    void this.sender.call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
  }

  private typing(chatId: string): void {
    void this.sender.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }
}

/** Что из сообщения нужно для задачи. */
function inputOf(msg: any): Input {
  const text = typeof msg?.text === 'string' ? msg.text : typeof msg?.caption === 'string' ? msg.caption : undefined;
  const forwarded = isForwarded(msg);
  return {
    text,
    voice: msg?.voice?.file_id && !text?.trim() ? { fileId: String(msg.voice.file_id), duration: Number(msg.voice.duration ?? 0) } : undefined,
    forwarded,
    from: forwarded ? forwardFrom(msg) : null,
  };
}

/** Сообщение до выбора кнопкой: только то, что нужно задаче или дейлику, на 10 минут. */
function slim(msg: any): Record<string, unknown> {
  return {
    message_id: msg.message_id,
    from: { id: msg.from.id },
    chat: { id: msg.chat?.id ?? msg.from.id, type: msg.chat?.type ?? 'private' },
    ...(typeof msg.text === 'string' ? { text: msg.text } : {}),
    ...(typeof msg.caption === 'string' ? { caption: msg.caption } : {}),
    ...(msg.voice?.file_id ? { voice: { file_id: String(msg.voice.file_id), duration: Number(msg.voice.duration ?? 0) } } : {}),
  };
}
