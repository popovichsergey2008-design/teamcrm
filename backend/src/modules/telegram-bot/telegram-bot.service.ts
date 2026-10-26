import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PoolClient } from 'pg';
import { AppException } from '../../common/http/app-exception';
import { telegramServiceEmail } from '../../common/mail/service-email';
import { AiService } from '../ai/ai.service';
import { AuthService, SessionMeta } from '../auth/auth.service';
import { LeadsService } from '../leads/leads.service';
import { ProjectsService } from '../projects/projects.service';
import { StandupService } from '../standup/standup.service';
import { TasksService } from '../tasks/tasks.service';
import { InvitesService } from '../team/invites.service';
import { TelegramSender } from '../telegram/telegram.sender';
import { TelegramService } from '../telegram/telegram.service';
import { UsersRepository } from '../users/users.repository';
import { CARD_PROMPT, cardByRules, cardFromModel, cardText, DemoCard, deadlineIso, exampleCard } from './bot-demo-rules';
import {
  decideDemo, hashCode, LOGIN_CODE_TTL_MS, loginUrl, looksLikeLoginCode, MOVE_FROM, newLoginCode, routeUpdate,
  TEAM_SIZES, trialDaysLeft,
} from './bot-rules';
import * as T from './bot-texts';
import { TelegramBotRepository } from './telegram-bot.repository';
import { TelegramBotWorkService } from './telegram-bot-work.service';

/** Пробный период (решение 26.10): 7 дней сразу + 7 за ответ о размере команды. */
const TRIAL_DAYS = 7;
const TRIAL_BONUS_DAYS = 7;
/** Сколько ждём модель на демо: дольше человек в чате не ждёт — дальше правила. */
const MODEL_TIMEOUT_MS = 6000;
/** Оценка расхода: gpt-4o-mini на одну карточку и быстрая расшифровка за минуту. */
const COST_CARD = 0.0005;
const COST_STT_PER_MIN = 0.003;

interface Who { tgId: string; chatId: string; firstName: string | null; lastName: string | null; username: string | null }
interface Own { tenantId: string; userId: string }

const INVALID_LOGIN = 'Ссылка входа недействительна или устарела — нажмите «Открыть мой QEVO» в Telegram-боте ещё раз';

/**
 * Telegram-бот QEVO для сайта (#4619, этапы 1–3).
 *
 * Один бот на всё (@teamsmrt_bot): диспетчер решает, чьё обновление. Сотрудник,
 * привязанный кодом из CRM, работает как раньше — дейлик, клиенты по ссылке c_…
 * (#1525) и копии уведомлений не трогаются. Непривязанный — гость с сайта: демо
 * «голос/текст → карточка задачи» без записи в CRM, затем пространство в один клик
 * по Telegram ID, пробный период 7 + 7 и вход без пароля.
 *
 * Демо отвечает синхронно, внутри вебхука: очередь добавила бы секунды к «за 2 секунды».
 */
@Injectable()
export class TelegramBotService {
  private readonly log = new Logger('TelegramBot');
  private readonly base: string;
  private readonly perUserDaily: number;
  private readonly dailyBudget: number;
  /** Telegram повторяет обновление, если ответ задержался: второй раз не отвечаем. */
  private readonly seen = new Set<number>();
  /** Двойное «Принимаю» не заводит два пространства (API — один процесс). */
  private readonly creating = new Map<string, Promise<void>>();

  constructor(
    config: ConfigService,
    private readonly repo: TelegramBotRepository,
    private readonly telegram: TelegramService,
    private readonly sender: TelegramSender,
    private readonly standup: StandupService,
    private readonly ai: AiService,
    private readonly auth: AuthService,
    private readonly users: UsersRepository,
    private readonly projects: ProjectsService,
    private readonly tasks: TasksService,
    private readonly invites: InvitesService,
    private readonly leads: LeadsService,
    private readonly work: TelegramBotWorkService,
  ) {
    this.base = (config.get<string>('APP_BASE_URL') || 'https://app.qevo.one').replace(/\/+$/, '');
    this.perUserDaily = Number(config.get<string>('TG_DEMO_PER_USER_DAILY')) || 5;
    this.dailyBudget = Number(config.get<string>('TG_DEMO_DAILY_BUDGET')) || 300;
  }

  // ───────────────────────────── диспетчер ─────────────────────────────

  async handle(update: any): Promise<void> {
    const startedAt = Date.now();
    const uid = update?.update_id;
    if (typeof uid === 'number') {
      if (this.seen.has(uid)) return;
      this.seen.add(uid);
      if (this.seen.size > 5000) this.seen.clear();
    }
    const from = update?.callback_query?.from ?? update?.message?.from;
    const actor = from?.id ? await this.telegram.resolveActor(from.id) : null;
    const route = routeUpdate(update, !!actor);

    // кнопки дейлика и клиентская ссылка — прежним путём
    if (route.kind === 'standup_callback') {
      this.answer(update.callback_query);
      return this.standup.handleTelegramUpdate(update);
    }
    if (route.kind === 'client_start') return this.standup.handleTelegramUpdate(update);
    // привязанный сотрудник (этап 4): пересылка/поручение → задача, дейлик — по правилу staffIntent
    if (route.kind === 'staff' && actor) {
      try {
        return await this.work.onStaffMessage(update, actor);
      } catch (e) {
        this.log.warn(`сотрудник, обновление ${uid}: ${(e as Error).message}`);
        void this.say(String(update?.message?.chat?.id ?? from.id), { text: T.SOMETHING_WRONG });
        return;
      }
    }
    if (route.kind === 'staff') return this.standup.handleTelegramUpdate(update);
    if (route.kind === 'ignore') return;

    const who: Who = {
      tgId: String(from.id),
      chatId: String(update?.message?.chat?.id ?? update?.callback_query?.message?.chat?.id ?? from.id),
      firstName: from.first_name ?? null, lastName: from.last_name ?? null, username: from.username ?? null,
    };
    const label = route.kind === 'start' ? route.label : null;
    await this.repo.touchUser(who.tgId, who.firstName, who.username, label).catch((e) => this.log.warn(`touch: ${(e as Error).message}`));

    try {
      switch (route.kind) {
        case 'bot_callback':
          this.answer(update.callback_query);
          return await this.onButton(who, route.data, startedAt, update.callback_query?.message?.message_id ?? null);
        case 'link_code': {
          const linked = await this.telegram.tryLink(who.tgId, route.code);
          return this.say(who.chatId, {
            text: linked ? '✅ Аккаунт привязан. Можно присылать дейлик.' : 'Код не подошёл или устарел. Получите новый в QEVO: Личный кабинет → «Открыть бота».',
          });
        }
        case 'start': return await this.onStart(who, actor ? { tenantId: actor.tenant_id, userId: actor.user_id } : null);
        case 'login': return await this.openLink(who);
        case 'example': return await this.example(who, startedAt);
        case 'demo_text': {
          // клиент, которому прислали итоги встречи (#1525), пишет в свой чат — это не демо
          const name = [who.firstName, who.lastName].filter(Boolean).join(' ') || who.username;
          if (await this.telegram.handleExternal(who.chatId, route.text, { staff: false, name })) return;
          return await this.demo(who, { text: route.text, forwarded: route.forwarded }, startedAt);
        }
        case 'demo_voice': return await this.demo(who, { voice: { fileId: route.fileId, duration: route.duration } }, startedAt);
        case 'unsupported': return this.say(who.chatId, { text: T.UNSUPPORTED });
      }
    } catch (e) {
      this.log.warn(`обновление ${uid}: ${(e as Error).message}`);
      void this.say(who.chatId, { text: T.SOMETHING_WRONG });
    }
  }

  private async onStart(who: Who, own: Own | null): Promise<void> {
    if (!own) return this.say(who.chatId, T.welcome(this.base));
    const [person, trial] = await Promise.all([this.repo.roleOf(own.tenantId, own.userId), this.repo.trialOf(own.tenantId)]);
    const days = person?.role_code === 'owner' ? trialDaysLeft(trial?.trial_ends_at) : null;
    return this.say(who.chatId, T.welcomeBack(who.firstName, days, this.base));
  }

  private async onButton(who: Who, data: string, startedAt: number, cbMessageId: number | null = null): Promise<void> {
    const [, action, arg = ''] = data.split(':');
    // рабочие кнопки сотрудника: задача/дейлик, «Отменить», «Принять / Вернуть»
    if (await this.work.onButton(who.tgId, who.chatId, action, arg, typeof cbMessageId === 'number' ? cbMessageId : null)) return;
    switch (action) {
      case 'ex': return this.example(who, startedAt);
      case 'ag': return this.say(who.chatId, { text: T.AGAIN });
      case 'mv': return this.say(who.chatId, T.moveFrom());
      case 'fr': return this.moveLead(who, MOVE_FROM[arg] ?? 'other');
      case 'tk': return this.take(who, arg);
      case 'ok': return this.accept(who, arg);
      case 'no': return this.say(who.chatId, { text: T.CONSENT_CANCELLED });
      case 'tm': return this.teamSize(who, TEAM_SIZES[arg] ?? null);
      case 'in': return this.invite(who);
      case 'op': return this.openLink(who);
      default: return;
    }
  }

  // ───────────────────────────── демо ─────────────────────────────

  private async example(who: Who, startedAt: number): Promise<void> {
    this.typing(who.chatId);
    const now = new Date();
    const card = exampleCard(now);
    const id = await this.repo.saveDemo({ tgId: who.tgId, kind: 'example', mode: 'rules', card, audioSeconds: null, elapsedMs: Date.now() - startedAt, cost: 0 });
    return this.say(who.chatId, { text: cardText(card, Date.now() - startedAt, now), markup: T.cardButtons(id, this.base) });
  }

  private async demo(who: Who, input: { text?: string; forwarded?: boolean; voice?: { fileId: string; duration: number } }, startedAt: number): Promise<void> {
    const ai = this.ai.botDemoAi();
    const counts = await this.repo.demoCounts(who.tgId);
    const decision = decideDemo({
      kind: input.voice ? 'voice' : 'text',
      userToday: counts.user, userLimit: this.perUserDaily,
      aiToday: counts.ai, aiBudget: this.dailyBudget,
      hasModel: !!ai.generate, hasStt: !!ai.transcribe,
      voiceSeconds: input.voice?.duration,
    });
    if (!decision.ok) {
      if (decision.why === 'user_limit') return this.say(who.chatId, T.userLimit(await this.repo.lastDemoId(who.tgId)));
      return this.say(who.chatId, { text: decision.why === 'voice_too_long' ? T.VOICE_TOO_LONG : T.VOICE_UNAVAILABLE });
    }
    this.typing(who.chatId);

    let text = input.text ?? '';
    let cost = 0;
    if (input.voice) {
      const audio = await this.sender.fileBuffer(input.voice.fileId);
      text = audio && ai.transcribe ? (await ai.transcribe(audio, 'voice.ogg').catch(() => '')).trim() : '';
      audio?.fill(0); // звук не храним: расшифровка — всё, что от него остаётся
      cost += (Math.max(input.voice.duration, 1) / 60) * COST_STT_PER_MIN;
      if (!text) return this.say(who.chatId, { text: T.VOICE_FAILED });
    }

    const now = new Date();
    const forwarded = !!input.forwarded;
    const rules = cardByRules(text, now, forwarded);
    let card: DemoCard | null = null;
    let usedModel = false;
    if (decision.mode === 'ai' && ai.generate) {
      usedModel = true;
      const today = now.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });
      const raw = await ai.generate(
        CARD_PROMPT,
        `Сегодня: ${today} (${now.toISOString().slice(0, 10)}).\n${forwarded ? 'Пересланное сообщение' : 'Поручение'}:\n"""\n${text.slice(0, 1500)}\n"""`,
        MODEL_TIMEOUT_MS,
      ).catch(() => '');
      cost += COST_CARD;
      card = cardFromModel(raw, rules, now, forwarded);
    }
    card = card ?? rules;
    if (!card) {
      if (usedModel || input.voice) {
        await this.repo.saveDemo({ tgId: who.tgId, kind: input.voice ? 'voice' : forwarded ? 'forward' : 'text', mode: 'ai',
          card: { title: '', assignee: null, deadline: null, time: null, project: '', checklist: [] }, audioSeconds: input.voice?.duration ?? null,
          elapsedMs: Date.now() - startedAt, cost });
      }
      return this.say(who.chatId, { text: T.CANT_PARSE });
    }
    const elapsed = Date.now() - startedAt;
    const id = await this.repo.saveDemo({
      tgId: who.tgId, kind: input.voice ? 'voice' : forwarded ? 'forward' : 'text', mode: usedModel || input.voice ? 'ai' : 'rules',
      card, audioSeconds: input.voice?.duration ?? null, elapsedMs: elapsed, cost: Number(cost.toFixed(4)),
    });
    return this.say(who.chatId, { text: cardText(card, elapsed, now), markup: T.cardButtons(id, this.base) });
  }

  // ───────────────────────────── аккаунт в один клик ─────────────────────────────

  /**
   * Чьё пространство у этого Telegram. Привязка сотрудника (кодом из CRM), вход через
   * Telegram или учётка бота — всё это «уже есть»: второе не заводим и чужую привязку
   * не угоняем, а предлагаем войти в своё.
   */
  private async ownSpace(tgId: string): Promise<Own | null> {
    const actor = await this.telegram.resolveActor(tgId);
    if (actor) return { tenantId: String(actor.tenant_id), userId: String(actor.user_id) };
    const accountId = await this.repo.accountForTelegram(tgId, telegramServiceEmail(tgId));
    if (!accountId) return null;
    const member = await this.auth.memberOf(accountId);
    if (!member) return null;
    await this.repo.linkIfFree(String(member.tenant_id), String(member.id), tgId);
    return { tenantId: String(member.tenant_id), userId: String(member.id) };
  }

  private async take(who: Who, demoId: string): Promise<void> {
    if (await this.ownSpace(who.tgId)) return this.say(who.chatId, T.alreadyHas());
    return this.say(who.chatId, T.consent(this.base, /^\d+$/.test(demoId) ? demoId : '0'));
  }

  private async accept(who: Who, demoId: string): Promise<void> {
    const prev = this.creating.get(who.tgId);
    if (prev) { await prev.catch(() => undefined); return this.say(who.chatId, T.alreadyHas()); }
    const run = this.createSpace(who, demoId);
    this.creating.set(who.tgId, run);
    try { await run; } finally { this.creating.delete(who.tgId); }
  }

  private async createSpace(who: Who, demoId: string): Promise<void> {
    if (await this.ownSpace(who.tgId)) return this.say(who.chatId, T.alreadyHas());
    const first = (who.firstName || who.username || 'Руководитель').trim().slice(0, 60);
    const fullName = [who.firstName, who.lastName].filter(Boolean).join(' ').trim().slice(0, 120) || first;
    let user;
    try {
      user = await this.auth.createOwnerUser(
        telegramServiceEmail(who.tgId), fullName, `${first} — команда`.slice(0, 160),
        // вход через Telegram потом найдёт этот аккаунт (account_socials), как у входа виджетом
        async (accountId: string, client: PoolClient) => {
          await client.query(
            `INSERT INTO account_socials (account_id, provider, external_id) VALUES ($1, 'telegram', $2)
             ON CONFLICT DO NOTHING`, [accountId, who.tgId],
          );
        },
        undefined,
        // согласие нажато кнопкой «Принимаю» под ссылкой на политику (#4675)
        { flow: 'telegram_bot', telegramUserId: who.tgId },
      );
    } catch (e) {
      // гонка с параллельным нажатием или учётка уже есть — это «уже есть», не сбой
      if (e instanceof AppException || /duplicate key|unique/i.test((e as Error).message)) return this.say(who.chatId, T.alreadyHas());
      throw e;
    }
    const tenantId = String(user.tenant_id);
    const userId = String(user.id);
    await this.repo.linkIfFree(tenantId, userId, who.tgId);
    await this.repo.startTrial(tenantId, TRIAL_DAYS, 'telegram_bot');
    await this.repo.setSpace(who.tgId, tenantId, userId);

    const demo = /^\d+$/.test(demoId) && demoId !== '0' ? await this.repo.demoOf(who.tgId, demoId) : null;
    const card = demo?.card?.title ? demo.card : null;
    let title: string | null = null;
    let taskId: string | null = null;
    let projectName: string | null = null;
    try {
      projectName = card?.project || 'Мой первый проект';
      const project = await this.projects.create(tenantId, {
        name: projectName, description: 'Первый проект из Telegram-бота QEVO.', aliases: [],
      } as never) as { id: string | number };
      if (card && demo) {
        const task = await this.tasks.create(tenantId, {
          projectId: String(project.id), title: card.title.slice(0, 255), assigneeId: userId, managerId: userId,
          deadlineAt: deadlineIso(card), checklist: card.checklist,
          description: [
            'Поставлено из Telegram-бота QEVO.',
            ...(card.assignee ? [`Исполнитель по поручению: ${card.assignee}. Пригласите коллегу в команду — и передайте задачу ему.`] : []),
          ].join('\n'),
        } as never, userId);
        await this.repo.claimDemo(demo.id, String(task.id));
        title = card.title;
        taskId = String(task.id);
      }
    } catch (e) {
      // пространство уже есть — без первой задачи человек проживёт, без входа нет
      this.log.warn(`первый проект ${tenantId}: ${(e as Error).message}`);
    }
    return this.say(who.chatId, T.created(title, title ? projectName : null, taskId ? `${this.base}/tg/task/${taskId}` : null));
  }

  private async teamSize(who: Who, size: string | null): Promise<void> {
    const own = await this.ownSpace(who.tgId);
    if (!own) return this.say(who.chatId, { text: T.NO_SPACE });
    if (size) {
      const prev = await this.repo.setTeamSize(who.tgId, size);
      if (prev === null) {
        await this.repo.addTrialBonus(own.tenantId, TRIAL_BONUS_DAYS);
        await this.leads.create({
          source: 'telegram', team: size, ip: 'telegram', ...this.contact(who),
          tenantId: own.tenantId, telegramUserId: who.tgId,
        }).catch((e) => this.log.warn(`заявка: ${(e as Error).message}`));
      }
    }
    const trial = await this.repo.trialOf(own.tenantId);
    const link = await this.issueLogin(who.tgId, own);
    return this.say(who.chatId, T.activated(link, trialDaysLeft(trial?.trial_ends_at)));
  }

  private async invite(who: Who): Promise<void> {
    const own = await this.ownSpace(who.tgId);
    if (!own) return this.say(who.chatId, { text: T.NO_SPACE });
    const person = await this.repo.roleOf(own.tenantId, own.userId);
    if (!person || !['owner', 'manager'].includes(person.role_code)) return this.say(who.chatId, { text: T.INVITE_DENIED });
    const link = await this.invites.createLink(own.tenantId, own.userId, { role: 'member', expiresInDays: 30 });
    return this.say(who.chatId, T.invite(`${this.base}/?join=${link.token}`));
  }

  private async moveLead(who: Who, from: string): Promise<void> {
    if (await this.repo.recentPlanLead(who.tgId)) return this.say(who.chatId, { text: T.MOVE_REPEAT });
    const [own, bu] = await Promise.all([this.ownSpace(who.tgId), this.repo.botUser(who.tgId)]);
    await this.leads.create({
      source: 'telegram', want: 'plan', from, team: bu?.team_size ?? undefined, ip: 'telegram', ...this.contact(who),
      tenantId: own?.tenantId ?? null, telegramUserId: who.tgId,
    });
    return this.say(who.chatId, { text: T.MOVE_ACCEPTED });
  }

  /** Контакт для дежурного: ник, если есть; без ника — ссылка на чат по ID. */
  private contact(who: Who): { contact: string; contactLine: string } {
    const name = [who.firstName, who.lastName].filter(Boolean).join(' ');
    if (who.username) return { contact: `@${who.username}`, contactLine: `Telegram: @${who.username}${name ? ` (${name})` : ''}` };
    return { contact: `tg:${who.tgId}`, contactLine: `Telegram: tg://user?id=${who.tgId}${name ? ` (${name})` : ''}, ника нет` };
  }

  // ───────────────────────────── вход без пароля ─────────────────────────────

  private async openLink(who: Who): Promise<void> {
    const own = await this.ownSpace(who.tgId);
    if (!own) return this.say(who.chatId, { text: T.NO_SPACE });
    return this.say(who.chatId, T.loginLinkMessage(await this.issueLogin(who.tgId, own)));
  }

  private async issueLogin(tgId: string, own: Own): Promise<string> {
    const code = newLoginCode();
    await this.repo.createLoginCode(hashCode(code), tgId, own.tenantId, own.userId, new Date(Date.now() + LOGIN_CODE_TTL_MS));
    return loginUrl(this.base, code);
  }

  /** Обмен кода из ?tglogin= на обычную сессию. Код одноразовый и живёт 10 минут. */
  async exchangeLogin(code: unknown, meta?: SessionMeta) {
    if (!looksLikeLoginCode(code)) throw AppException.unauthorized(INVALID_LOGIN);
    const row = await this.repo.consumeLoginCode(hashCode(code));
    if (!row) throw AppException.unauthorized(INVALID_LOGIN);
    const user = await this.users.findById(row.tenant_id, row.user_id);
    if (!user?.is_active) throw AppException.unauthorized(INVALID_LOGIN);
    return this.auth.sessionFor(user, meta);
  }

  // ───────────────────────────── профиль бота ─────────────────────────────

  /**
   * Имя, описание, короткое описание и команды бота через Bot API. Вызывается вручную
   * (админ платформы) — не при старте: описание меняется редко, а у Telegram на эти
   * методы жёсткий лимит частоты. Аватар и GIF описания — только в BotFather.
   */
  async setupProfile(): Promise<Record<string, boolean>> {
    const r = async (method: string, body: Record<string, unknown>) => (await this.sender.call(method, body)) !== null;
    return {
      setMyName: await r('setMyName', { name: T.BOT_NAME }),
      setMyDescription: await r('setMyDescription', { description: T.BOT_DESCRIPTION }),
      setMyShortDescription: await r('setMyShortDescription', { short_description: T.BOT_SHORT_DESCRIPTION }),
      setMyCommands: await r('setMyCommands', { commands: T.BOT_COMMANDS }),
    };
  }

  // ───────────────────────────── отправка ─────────────────────────────

  private say(chatId: string, m: { text: string; markup?: T.Keyboard }): Promise<void> {
    return this.sender.call('sendMessage', {
      chat_id: chatId, text: m.text.slice(0, 4096),
      ...(m.markup ? { reply_markup: m.markup } : {}),
      link_preview_options: { is_disabled: true },
    }).then(() => undefined);
  }

  /** «Печатает…» — не ждём ответа Telegram: разбор идёт параллельно. */
  private typing(chatId: string): void {
    void this.sender.call('sendChatAction', { chat_id: chatId, action: 'typing' });
  }

  /** Ответ на нажатие — всегда, иначе у кнопки крутятся «часики». */
  private answer(cb: any): void {
    if (cb?.id) void this.sender.call('answerCallbackQuery', { callback_query_id: String(cb.id) });
  }
}

