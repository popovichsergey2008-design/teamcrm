import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { ProjectViewer } from '../../common/access/project-visibility';
import { runsBackground } from '../../common/process-role';
import { trackBackground } from '../../common/background-work';
import { AiService } from '../ai/ai.service';
import { TRIAL_TEXT } from '../billing/trial-limits.service';
import { ChatsRepository } from '../chats/chats.repository';
import { FilesService } from '../files/files.service';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { RealtimeService } from '../realtime/realtime.service';
import { TasksService } from '../tasks/tasks.service';
import {
  cleanAiTitle, fallbackTitle, groupByPerson, isDefaultTitle, isShortEmptyCall, PersonTasks, retellFallback, trimWords,
} from './meeting-recap-rules';
import { CardKind, CardRow, MeetingRecapRepository } from './meeting-recap.repository';
import { MeetingsRepository } from './meetings.repository';
import { MeetingsService } from './meetings.service';

const TITLE_PROMPT = [
  'Придумай название рабочей встречи по её итогам.',
  'Формат: «Тема: о чём договорились», 3–9 слов. Без кавычек, без даты, без слов «созвон» и «встреча».',
  'Пример: Кевабот: вкладки разговоров и 10 сценариев',
  'Ответь только названием, одной строкой.',
].join('\n');

const RETELL_PROMPT = [
  'Перескажи рабочую встречу коллеге, который её пропустил, так, чтобы это прочитать вслух за одну минуту.',
  'До 130 слов, разговорным языком, без списков, markdown и эмодзи.',
  'Сначала главное решение, потом кто что делает и к какому сроку, в конце — риск, если он есть.',
  'Не придумывай того, чего нет в итогах.',
].join('\n');

type Viewer = ProjectViewer & { userId: string };

/**
 * #4902, п. 10–11: итоги созвона живут в чате, а не в разделе «Встречи».
 *
 * Раньше разбор оседал в списке встреч под названием «Созвон 11.11, 09:22», половина
 * итогов так и висела «не разобраны», а упавшая обработка — «Ошибкой» навсегда. Теперь:
 * встреча получает осмысленное название, в чат, откуда звонили, приходит карточка итогов,
 * каждый исполнитель — личное сообщение со своими задачами и кнопками, неподтверждённое
 * через сутки напоминается один раз, сбой повторяется сам один раз, потом — «Повторить».
 *
 * Сообщения — обычные chat_messages с meeting_id: в выгрузках и письмах остаётся текст,
 * а интерфейс по номеру сообщения разворачивает живую карточку (/meeting-cards/:id).
 */
@Injectable()
export class MeetingRecapService implements OnModuleInit {
  private readonly log = new Logger('MeetingRecap');

  constructor(
    private readonly repo: MeetingRecapRepository,
    private readonly meetingsRepo: MeetingsRepository,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly scheduler: ProactiveScheduler,
    private readonly chats: ChatsRepository,
    private readonly tasks: TasksService,
    private readonly meetings: MeetingsService,
  ) {}

  onModuleInit(): void {
    // конвейер встреч зовёт нас через подписку: прямой импорт дал бы кольцо файлов и модулей
    this.meetings.useRecap({
      afterAnalysis: (t, id) => this.afterAnalysis(t, id),
      onFailed: (t, id) => this.onFailed(t, id),
      assigneeChanged: (t, id) => this.sendConfirmations(t, id).then(() => undefined),
    });
    this.scheduler.add('итоги встреч: автоповтор после ошибки', async () => { await this.retryDue(); });
    this.scheduler.add('итоги встреч: напоминание подтвердить задачи', async () => { await this.remindDue(); });
    if (!runsBackground() || process.env.NODE_ENV === 'test') return;
    // старые «Созвон 11.11, 09:22» с готовыми итогами — переименовать задним числом, понемногу
    const t = setTimeout(() => { void trackBackground(this.backfillTitles(30)); }, 3 * 60_000);
    t.unref?.();
  }

  // ---------- после разбора ----------

  /**
   * Разбор готов: название → карточка в чат → личные списки задач. Каждый шаг сам по
   * себе: не придумалось название — карточка всё равно уходит, и наоборот.
   */
  async afterAnalysis(tenantId: string, meetingId: string): Promise<void> {
    await this.repo.clearRetell(meetingId).catch(() => undefined);
    await this.ensureTitle(tenantId, meetingId).catch((e) => this.log.warn(`название встречи ${meetingId}: ${(e as Error).message}`));
    const m = await this.meetingsRepo.get(tenantId, meetingId);
    if (!m) return;
    const chatId = (m as { chat_id?: string | null }).chat_id ?? null;
    if (chatId) {
      await this.postCard(tenantId, String(chatId), meetingId, 'recap', null, await this.recapBody(tenantId, meetingId))
        .catch((e) => this.log.warn(`карточка итогов ${meetingId}: ${(e as Error).message}`));
    }
    await this.sendConfirmations(tenantId, meetingId).catch((e) => this.log.warn(`подтверждения ${meetingId}: ${(e as Error).message}`));
    // карточка ошибки, если была, теперь показывает «обработано»
    await this.refresh(tenantId, meetingId);
  }

  /** Название от ИИ вместо «Созвон 11.11, 09:22»; модели нет — первое предложение итогов. */
  async ensureTitle(tenantId: string, meetingId: string): Promise<string | null> {
    const m = await this.meetingsRepo.get(tenantId, meetingId);
    if (!m || (m as { title_ai?: boolean }).title_ai || !isDefaultTitle(m.title)) return null;
    const [summary, decisions] = await Promise.all([
      this.meetingsRepo.summary(tenantId, meetingId).catch(() => null),
      this.meetingsRepo.meetingDecisions(tenantId, meetingId).catch(() => []),
    ]);
    // служебные строки итогов (лимит пробного, «ИИ не смог…») — не тема встречи
    const raw = String(summary?.summary ?? '').replace(TRIAL_TEXT.callCutProtocol, '').trim();
    const text = /^ИИ не смог разобрать/i.test(raw) ? '' : raw;
    const dec = decisions.map((d) => d.text);
    if (!text && !dec.length) return null;
    let title: string | null = null;
    try {
      const r = await this.ai.generateWithModel(tenantId, TITLE_PROMPT,
        [`Итоги: ${text.slice(0, 2000)}`, dec.length ? `Решения: ${dec.slice(0, 8).join('; ')}` : ''].filter(Boolean).join('\n'),
        'meeting_title', { maxTokens: 60, timeoutMs: 20_000 });
      if (!r.degraded) title = cleanAiTitle(r.text);
    } catch (e) {
      this.log.log(`встреча ${meetingId}: название моделью не вышло — ${(e as Error).message}`);
    }
    title = title ?? fallbackTitle(text, dec);
    if (!title) return null;
    return (await this.repo.setAiTitle(meetingId, m.title, title)) ? title : null;
  }

  private async backfillTitles(limit: number): Promise<void> {
    for (const m of await this.repo.untitled(limit).catch(() => [])) {
      await this.ensureTitle(m.tenant_id, m.id).catch(() => undefined);
    }
  }

  /** Текст карточки для писем, выгрузок и старых клиентов: первая строка — заголовок. */
  private async recapBody(tenantId: string, meetingId: string): Promise<string> {
    const [m, summary, drafts] = await Promise.all([
      this.meetingsRepo.get(tenantId, meetingId),
      this.meetingsRepo.summary(tenantId, meetingId).catch(() => null),
      this.meetingsRepo.drafts(tenantId, meetingId).catch(() => []),
    ]);
    const mins = Math.max(1, Math.round(Number(m?.duration_sec ?? 0) / 60));
    const lines = [`${m?.title ?? 'Созвон'} · ${mins} мин`];
    const text = String(summary?.summary ?? '').trim();
    if (text) lines.push(text.slice(0, 600));
    const live = drafts.filter((d) => d.status !== 'rejected').length;
    if (live) lines.push(`Задач по итогам: ${live}`);
    return lines.join('\n');
  }

  /**
   * Опубликовать карточку: занять место (одна на вид), записать сообщение, показать всем
   * в чате сразу, как обычное сообщение. Не ушло — место освобождается.
   */
  private async postCard(
    tenantId: string, chatId: string, meetingId: string, kind: CardKind, userId: string | null, body: string,
  ): Promise<string | null> {
    const cardId = await this.repo.claimCard(tenantId, meetingId, kind, userId);
    if (!cardId) return null;
    try {
      const messageId = await this.meetingsRepo.postMeetingCard(tenantId, chatId, meetingId, body);
      if (!messageId) { await this.repo.dropCard(cardId); return null; }
      await this.repo.setCardMessage(cardId, String(messageId));
      const to = await this.meetingsRepo.chatAudience(tenantId, chatId);
      this.realtime.emitToUsers(tenantId, to, 'chat.message', {
        chatId,
        message: {
          id: messageId, chat_id: chatId, author_id: null, author_name: null,
          body, file_id: null, file_name: null,
          created_at: new Date().toISOString(), edited_at: null, meeting_id: String(meetingId),
        },
      });
      return String(messageId);
    } catch (e) {
      await this.repo.dropCard(cardId).catch(() => undefined);
      throw e;
    }
  }

  /**
   * Личные сообщения со своими задачами (п. 11) — в «Заметки» исполнителя: это его
   * личный чат, он уже есть на телефоне и в Telegram-зеркале. Сообщение без автора
   * не даёт push само — поэтому отдельно уведомление и Telegram.
   */
  async sendConfirmations(tenantId: string, meetingId: string): Promise<number> {
    const m = await this.meetingsRepo.get(tenantId, meetingId);
    if (!m) return 0;
    let sent = 0;
    for (const { user_id: userId } of await this.repo.assignees(tenantId, meetingId)) {
      try {
        const mine = (await this.repo.myDrafts(tenantId, meetingId, userId)).filter((d) => !d.confirm_state);
        if (!mine.length) continue;
        const self = await this.chats.ensureSelfChat(tenantId, userId);
        const body = [
          `Ваши задачи со встречи «${m.title}»: ${mine.length}`,
          ...mine.slice(0, 10).map((d) => `• ${d.title}`),
          'Подтвердите каждую: «✓ беру», «срок» или «не моё».',
        ].join('\n');
        const messageId = await this.postCard(tenantId, String(self.id), meetingId, 'confirm', userId, body);
        if (!messageId) continue;
        sent++;
        const title = `Задачи со встречи «${m.title}»`.slice(0, 120);
        const text = `${mine.length} — подтвердите: беру, срок или не моё`;
        await this.push.personal({ tenantId, userId, eventKey: 'meeting.confirm', title, body: text, path: `/chat/${self.id}` }).catch(() => false);
        await this.telegram.push(tenantId, userId, `${title}\n\n${body}`).catch(() => false);
      } catch (e) {
        this.log.warn(`встреча ${meetingId}: список задач ${userId} не ушёл — ${(e as Error).message}`);
      }
    }
    return sent;
  }

  // ---------- ошибки ----------

  /**
   * Обработка упала. Короткий звонок без речи — не встреча: молчим. Первый раз —
   * автоповтор через минуту (сбой сети, перегрузка API обычно проходят); повтор тоже
   * упал — бот показывает ошибку с «Повторить» в чате, откуда звонили (или в «Заметках» хозяина).
   */
  async onFailed(tenantId: string, meetingId: string): Promise<void> {
    try {
      const m = await this.meetingsRepo.get(tenantId, meetingId);
      if (!m) return;
      if (isShortEmptyCall(m, await this.repo.segmentsCount(meetingId))) return;
      const st = await this.repo.scheduleRetry(meetingId);
      if (st !== 'exhausted') return;
      const chatId = (m as { chat_id?: string | null }).chat_id ?? null;
      const owner = await this.repo.ownerOf(meetingId);
      const target = chatId ? String(chatId) : owner ? String((await this.chats.ensureSelfChat(tenantId, owner)).id) : null;
      if (!target) return;
      const body = `Не удалось обработать созвон «${m.title}». ${String(m.error ?? '').slice(0, 300)}`.trim();
      const posted = await this.postCard(tenantId, target, meetingId, 'error', null, body);
      if (!posted) { await this.refresh(tenantId, meetingId); return; }
      if (owner) {
        await this.push.personal({
          tenantId, userId: owner, eventKey: 'meeting.error', title: `Созвон не обработан: ${m.title}`.slice(0, 120),
          body: 'Повторили автоматически — не вышло. Нажмите «Повторить» в карточке.', path: `/chat/${target}`,
        }).catch(() => false);
      }
    } catch (e) {
      this.log.warn(`встреча ${meetingId}: ошибка не показана — ${(e as Error).message}`);
    }
  }

  /** Автоповтор (раз в два минуты планировщиком): одна попытка на встречу. */
  async retryDue(): Promise<number> {
    let n = 0;
    for (const m of await this.repo.dueRetries()) {
      if (!(await this.repo.claimRetry(m.id))) continue;
      this.log.log(`встреча ${m.id}: автоповтор после ошибки`);
      await this.meetings.reanalyze(m.tenant_id, m.id).catch((e) => this.log.warn(`автоповтор ${m.id}: ${(e as Error).message}`));
      n++;
    }
    return n;
  }

  // ---------- напоминание ----------

  /** Неподтверждённые за сутки — одно напоминание на карточку. */
  async remindDue(): Promise<number> {
    let n = 0;
    for (const r of await this.repo.dueReminders()) {
      if (!(await this.repo.claimReminder(r.id))) continue;
      const title = `Подтвердите задачи со встречи «${r.title}»`.slice(0, 120);
      const body = `Осталось ${r.left}: «✓ беру», «срок» или «не моё».`;
      await this.push.personal({ tenantId: r.tenant_id, userId: r.user_id, eventKey: 'meeting.confirm', title, body, path: `/chat/${r.chat_id}` }).catch(() => false);
      await this.telegram.push(r.tenant_id, r.user_id, `${title}\n${body}`).catch(() => false);
      n++;
    }
    return n;
  }

  // ---------- карточка в интерфейсе ----------

  private async card(tenantId: string, messageId: string, viewer: Viewer): Promise<CardRow> {
    const c = await this.repo.cardByMessage(tenantId, String(messageId));
    if (!c || !(await this.repo.inChat(c.chat_id, viewer.userId))) throw AppException.notFound('Карточка не найдена');
    // личный список — только своему адресату
    if (c.kind === 'confirm' && String(c.user_id) !== String(viewer.userId)) throw AppException.notFound('Карточка не найдена');
    return c;
  }

  /** Живые данные карточки: название, итоги, задачи по людям, мои задачи, статус обработки. */
  async view(tenantId: string, messageId: string, viewer: Viewer) {
    const c = await this.card(tenantId, messageId, viewer);
    const m = await this.meetingsRepo.get(tenantId, c.meeting_id);
    if (!m) throw AppException.notFound('Встреча не найдена');
    // итог видят те, кому видна встреча: закрытый проект не раскрываем через чат
    const visible = c.kind === 'confirm' || await this.meetingsRepo.visible(tenantId, c.meeting_id, viewer);
    const ext = m as typeof m & { auto_retry_at?: Date | null; auto_retried_at?: Date | null };
    const meeting = {
      id: String(m.id), title: m.title, status: m.status, error: visible ? m.error : null,
      durationMin: m.duration_sec ? Math.max(1, Math.round(Number(m.duration_sec) / 60)) : null,
      // ошибка ещё будет повторена сама — карточка так и скажет
      autoRetry: m.status === 'error' && ext.auto_retry_at && !ext.auto_retried_at ? 'scheduled' : null,
    };
    const mine = await this.repo.myDrafts(tenantId, c.meeting_id, viewer.userId);
    const myTasks = mine.map((d) => ({
      draftId: d.id, title: d.title, deadlineAt: d.deadline_at ? new Date(d.deadline_at).toISOString() : null,
      status: d.status, taskId: d.task_id, confirm: (d.confirm_state as 'taken' | 'declined' | null) ?? null,
      projectId: d.project_id, error: d.error_message,
    }));
    if (!visible) return { kind: c.kind, meeting: { ...meeting, title: 'Встреча' }, hidden: true, mine: myTasks };

    const [summary, decisions, drafts] = await Promise.all([
      this.meetingsRepo.summary(tenantId, c.meeting_id).catch(() => null),
      this.meetingsRepo.meetingDecisions(tenantId, c.meeting_id).catch(() => []),
      this.meetingsRepo.drafts(tenantId, c.meeting_id).catch(() => []),
    ]);
    const names = await this.repo.names(tenantId, [...new Set(drafts.map((d) => d.assignee_id).filter((x): x is string => !!x).map(String))]);
    const people = groupByPerson(drafts, names);
    const live = drafts.filter((d) => d.status !== 'rejected');
    const recording = m.file_id && m.source !== 'transcript' ? this.files.signPlay(tenantId, String(m.file_id), 1800) : null;
    return {
      kind: c.kind,
      meeting,
      hidden: false,
      summary: summary?.summary ?? null,
      decisions: decisions.length ? decisions.map((d) => d.text) : (summary?.decisions ?? []).map((d) => typeof d === 'string' ? d : String((d as { text?: string }).text ?? '')),
      risks: (summary?.risks ?? []).map(String),
      people,
      counts: { confirmed: live.filter((d) => (d as { confirm_state?: string | null }).confirm_state === 'taken').length, total: live.length },
      mine: myTasks,
      recording,
    };
  }

  /** Обновить карточки встречи у всех, кто их видит (после «беру», повтора, разбора). */
  private async refresh(tenantId: string, meetingId: string): Promise<void> {
    try {
      const ids = new Set<string>();
      for (const { chat_id } of await this.repo.cardChats(meetingId)) {
        for (const u of await this.meetingsRepo.chatAudience(tenantId, chat_id)) ids.add(u);
      }
      if (ids.size) this.realtime.emitToUsers(tenantId, [...ids], 'meeting.card', { meetingId: String(meetingId) });
    } catch { /* обновится при следующем открытии */ }
  }

  // ---------- кнопки исполнителя ----------

  private async ownDraft(tenantId: string, draftId: string, userId: string) {
    const d = await this.meetingsRepo.draft(tenantId, String(draftId));
    if (!d) throw AppException.notFound('Задача не найдена');
    if (String(d.assignee_id ?? '') !== String(userId)) throw AppException.forbidden('Это задача другого исполнителя');
    if (d.status === 'rejected') throw AppException.conflict('Задачу уже отклонили на экране итогов');
    return d;
  }

  /**
   * «✓ беру» (и «срок» — то же с датой). Черновик ещё не задача — создаём её тем же
   * путём, что экран итогов (applyDraft); уже создана сама — срок через просьбу о
   * переносе, как везде у исполнителя. Проекта нет — согласие сохраняется, а задачу
   * создаст хозяин встречи, выбрав проект.
   */
  async take(tenantId: string, viewer: Viewer, draftId: string, deadlineAt?: string | null): Promise<{ note: string | null }> {
    const d = await this.ownDraft(tenantId, draftId, viewer.userId);
    let note: string | null = null;
    if (d.status === 'pending' || d.status === 'failed') {
      try {
        await this.meetings.applyDraft(tenantId, viewer.userId, String(d.id), deadlineAt !== undefined ? { deadlineAt: deadlineAt ?? '' } : undefined);
      } catch (e) {
        if (deadlineAt !== undefined) await this.meetingsRepo.updateDraft(tenantId, String(d.id), { deadlineAt: deadlineAt || null }).catch(() => undefined);
        note = e instanceof AppException && /проект/i.test(e.message)
          ? 'Принято. Задача появится, когда хозяин встречи выберет проект.'
          : `Принято, но задача не создалась: ${(e as Error).message}`;
      }
    } else if (d.status === 'applied' && d.task_id && deadlineAt) {
      await this.tasks.askDeadlineShift(tenantId, String(d.task_id), { userId: viewer.userId, role: viewer.role }, new Date(deadlineAt))
        .then(() => { note = 'Новый срок отправлен постановщику на согласование.'; })
        .catch((e) => { note = `Срок не изменён: ${(e as Error).message}`; });
    }
    await this.repo.setConfirm(String(d.id), 'taken', viewer.userId);
    await this.refresh(tenantId, d.meeting_id);
    return { note };
  }

  /** «Не моё»: исполнитель снят (если задачи ещё нет), хозяин встречи узнаёт и переназначит. */
  async decline(tenantId: string, viewer: Viewer, draftId: string): Promise<{ note: string }> {
    const d = await this.ownDraft(tenantId, draftId, viewer.userId);
    await this.repo.setConfirm(String(d.id), 'declined', viewer.userId);
    const [m, owner, names] = await Promise.all([
      this.meetingsRepo.get(tenantId, d.meeting_id),
      this.repo.ownerOf(d.meeting_id),
      this.repo.names(tenantId, [viewer.userId]),
    ]);
    if (owner && owner !== String(viewer.userId)) {
      await this.push.personal({
        tenantId, userId: owner, eventKey: 'meeting.declined',
        title: `«Не моё»: ${d.title}`.slice(0, 120),
        body: `${names.get(String(viewer.userId)) ?? 'Исполнитель'} не берёт задачу со встречи «${m?.title ?? ''}». Назначьте другого исполнителя.`,
        path: `/meetings/${d.meeting_id}/postcall`, toast: true,
      }).catch(() => false);
    }
    await this.refresh(tenantId, d.meeting_id);
    return { note: owner && owner !== String(viewer.userId) ? 'Хозяин встречи получил уведомление и переназначит задачу.' : 'Отмечено.' };
  }

  /** «Подтвердить всё»: взять все свои неразобранные задачи встречи. */
  async confirmAll(tenantId: string, messageId: string, viewer: Viewer) {
    const c = await this.card(tenantId, messageId, viewer);
    const notes: string[] = [];
    let taken = 0;
    for (const d of await this.repo.myDrafts(tenantId, c.meeting_id, viewer.userId)) {
      if (d.confirm_state || String(d.assignee_id) !== String(viewer.userId)) continue;
      const r = await this.take(tenantId, viewer, d.id).catch((e) => ({ note: (e as Error).message }));
      taken++;
      if (r.note) notes.push(`«${d.title}»: ${r.note}`);
    }
    return { taken, notes };
  }

  /** «Повторить» из карточки ошибки: по готовой стенограмме, иначе полностью. */
  async retry(tenantId: string, messageId: string, viewer: Viewer) {
    const c = await this.card(tenantId, messageId, viewer);
    if (!(await this.meetingsRepo.visible(tenantId, c.meeting_id, viewer))) throw AppException.notFound('Встреча не найдена');
    const r = await this.meetings.reanalyze(tenantId, c.meeting_id);
    await this.refresh(tenantId, c.meeting_id);
    return r;
  }

  /**
   * «Пересказ за 1 минуту»: текст на минуту чтения и, если есть синтез речи, озвучка.
   * Делается один раз на встречу — повторное нажатие отдаёт готовое.
   */
  async retell(tenantId: string, messageId: string, viewer: Viewer): Promise<{ text: string; audio: { url: string } | null }> {
    const c = await this.card(tenantId, messageId, viewer);
    if (!(await this.meetingsRepo.visible(tenantId, c.meeting_id, viewer))) throw AppException.notFound('Встреча не найдена');
    const cached = await this.repo.retell(c.meeting_id);
    if (cached?.retell_text) {
      return { text: cached.retell_text, audio: cached.retell_file_id ? { url: this.files.signPlay(tenantId, cached.retell_file_id, 1800).url } : null };
    }
    const v = await this.view(tenantId, messageId, viewer) as {
      meeting: { title: string }; summary?: string | null; decisions?: string[]; risks?: string[]; people?: PersonTasks[];
    };
    const material = {
      title: v.meeting.title, summary: v.summary ?? null, decisions: v.decisions ?? [], risks: v.risks ?? [], people: v.people ?? [],
    };
    if (!material.summary && !material.decisions.length && !material.people.length) {
      throw AppException.validation('Итогов ещё нет — пересказывать нечего');
    }
    let text = '';
    try {
      const r = await this.ai.generateWithModel(tenantId, RETELL_PROMPT, [
        `Встреча: ${material.title}`,
        material.summary ? `Итоги: ${material.summary.slice(0, 3000)}` : '',
        material.decisions.length ? `Решения: ${material.decisions.slice(0, 10).join('; ')}` : '',
        material.people.length ? `Задачи: ${material.people.map((p) => `${p.name}: ${p.tasks.map((t) => t.title + (t.deadlineAt ? ` (до ${t.deadlineAt.slice(0, 10)})` : '')).join(', ')}`).join('; ')}` : '',
        material.risks.length ? `Риски: ${material.risks.join('; ')}` : '',
      ].filter(Boolean).join('\n'), 'meeting_retell', { maxTokens: 500, timeoutMs: 30_000 });
      if (!r.degraded) text = trimWords(String(r.text ?? '').replace(/[*#_`]/g, '').trim(), 150);
    } catch (e) {
      this.log.log(`пересказ ${c.meeting_id}: модель не ответила — ${(e as Error).message}`);
    }
    if (!text) text = retellFallback(material);
    let fileId: string | null = null;
    try {
      const audio = await this.ai.speak(tenantId, text, 'meeting_retell_voice');
      if (audio) {
        const f = await this.files.upload({
          tenantId, userId: viewer.userId, buffer: audio, fileName: `meeting-${c.meeting_id}-retell.mp3`,
          contentType: 'audio/mpeg', ownerKind: 'meeting_recording', ownerId: c.meeting_id,
        });
        fileId = String(f.id);
      }
    } catch (e) {
      // синтеза нет или сбой — пересказ остаётся текстом
      this.log.log(`пересказ ${c.meeting_id}: без озвучки — ${(e as Error).message}`);
    }
    await this.repo.saveRetell(c.meeting_id, text, fileId);
    return { text, audio: fileId ? { url: this.files.signPlay(tenantId, fileId, 1800).url } : null };
  }
}
