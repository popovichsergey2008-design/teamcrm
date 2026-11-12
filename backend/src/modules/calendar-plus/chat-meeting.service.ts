import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { zonedParts, zonedToUtc } from '../calendar/find-time';
import { ChatText, onChatText } from '../chats/chat-hooks';
import { ChatsRepository } from '../chats/chats.repository';
import { pickDay } from '../nl/event-draft';
import { RealtimeService } from '../realtime/realtime.service';
import { bestTime } from './best-time';
import { CalendarPlusRepository, ProposalRow } from './calendar-plus.repository';
import { CalendarPlusService } from './calendar-plus.service';
import { durationAnywhere, pickTopic } from './phrase-rules';

const DAY = 86_400_000;
const LETTER = '[а-яa-z0-9]';
/** Фразы «пора встретиться»: «давайте созвонимся», «встретимся завтра», «го в зум». */
export const MEETING_INTENT = new RegExp(
  `(?<!${LETTER})(?:созвонимся|созвониться|созвонимся|созвонитесь|созвон(?:ик)?\\s+(?:завтра|сегодня|в\\s|на\\s)|давайте\\s+(?:созвон|встрет|обсудим\\s+голосом|созвонимся)|давай\\s+(?:созвон|встрет)|встретимся|встретиться|назначим\\s+(?:встречу|созвон)|го\\s+(?:в\\s+)?(?:созвон|звонок|зум|zoom))(?!${LETTER})`,
  'i',
);
export const isMeetingCommand = (t: string) => /^\s*\/(?:встреча|meet|meeting)(?:\s|$)/i.test(t);

const AGENDA_SYSTEM = [
  'По переписке ниже сформулируй тему встречи в 2–5 словах (например «доступы к CRM»)',
  'и 1–3 пункта повестки, только из переписки, ничего не выдумывай.',
  'Ответ строго JSON: {"topic":"...","points":["...","..."]}',
].join('\n');

/**
 * Встреча прямо из чата (#4892, п. 5). Человек пишет «давайте созвонимся» — QEVO AI
 * предлагает 3 слота, когда свободны все участники чата; участники голосуют кнопками.
 * Когда проголосовали все или автор нажал «Назначить», встреча создаётся: участники
 * и тема — из чата, повестка — из обсуждения, ссылка на звонок — сама. Без нажатия
 * встреча не создаётся; предложение — не чаще раза на обсуждение; подсказку можно выключить.
 */
@Injectable()
export class ChatMeetingService implements OnModuleInit {
  private readonly log = new Logger('ChatMeeting');

  constructor(
    private readonly db: DbService,
    private readonly repo: CalendarPlusRepository,
    private readonly plus: CalendarPlusService,
    private readonly chats: ChatsRepository,
    private readonly realtime: RealtimeService,
    private readonly ai: AiService,
  ) {}

  onModuleInit(): void {
    onChatText((m) => this.onText(m));
  }

  private async onText(m: ChatText): Promise<void> {
    const command = isMeetingCommand(m.text);
    if (!command && !MEETING_INTENT.test(m.text)) return;
    if (m.chatKind === 'channel' || m.chatKind === 'external') return;
    if (!command) {
      const prefs = await this.repo.prefs(m.tenantId, m.authorId);
      if (prefs && (!prefs.chat_suggest || prefs.dismissed.includes(`chat:${m.chatId}`))) return;
      // не чаще одного предложения на обсуждение
      if (await this.repo.recentProposal(m.chatId, 6)) return;
    }
    await this.propose(m.tenantId, m.chatId, m.authorId, m.text, m.messageId, m.chatTitle).catch((e) => {
      this.log.warn(`предложение встречи в чате ${m.chatId}: ${(e as Error).message}`);
    });
  }

  private async members(tenantId: string, chatId: string) {
    return this.repo.chatMembers(tenantId, chatId);
  }

  /** Предложить 3 слота. Вызывается фразой, командой /встреча или кнопкой меню чата. */
  async propose(tenantId: string, chatId: string, authorId: string, text: string, sourceMessageId: string | null, chatTitle: string | null) {
    const members = await this.members(tenantId, chatId);
    if (!members.some((x) => x.id === String(authorId))) throw AppException.forbidden('Вы не участник этого чата');
    if (members.length < 2) throw AppException.validation('В чате один человек — встречаться не с кем');
    const tz = await this.plus.timezoneOf(tenantId, authorId);
    const minutes = durationAnywhere(text) ?? 30;
    const now = Date.now();
    // «встретимся завтра» — начиная с названного дня
    const localNow = new Date(new Date(now).toLocaleString('en-US', { timeZone: tz }));
    const day = pickDay(text, localNow);
    let notBefore: number | null = null;
    if (day) notBefore = zonedToUtc(day.getFullYear(), day.getMonth() + 1, day.getDate(), 0, 0, tz);
    const people = await this.plus.peopleFor(tenantId, authorId, members.map((x) => x.id), [], now - DAY, now + 12 * DAY);
    const res = bestTime({ now, minutes, people: people.map((p) => ({ ...p, me: p.id === String(authorId) })), viewerTimeZone: tz, days: 10, limit: 3, notBefore });
    if (!res.slots.length) throw AppException.conflict(res.message ?? 'Нет общего свободного времени');
    const slots = [...res.slots].sort((a, b) => Date.parse(a.startsAt) - Date.parse(b.startsAt))
      .map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt, reasons: s.reasons }));
    const topic = pickTopic(isMeetingCommand(text) ? text.replace(/^\s*\/\S+\s*/, '') : text) ?? null;
    const id = await this.repo.createProposal({
      tenantId, chatId, authorId, sourceMessageId, topic, minutes, memberIds: members.map((x) => x.id), slots,
    });
    const who = members.length === 2 ? 'оба' : members.length === 3 ? 'все трое' : `все ${members.length}`;
    const labels = slots.map((s) => this.label(s.startsAt, tz)).join(', ');
    const msg = await this.chats.addMessage({
      tenantId, chatId, authorId, fileId: null, isAi: true,
      body: `Похоже на встречу. Свободны ${who}: ${labels}. Голосуйте — встреча назначится, когда ответят все.`,
    });
    await this.repo.attachProposalMessage(id, String(msg.id));
    this.realtime.emitToUsers(tenantId, members.map((x) => x.id), 'chat.message', { chatId, message: { ...msg, proposal_id: id } });
    void chatTitle;
    return this.view(tenantId, authorId, id);
  }

  private label(iso: string, tz: string): string {
    const ms = Date.parse(iso);
    const d = zonedParts(ms, tz).date;
    const t = new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz });
    if (d === zonedParts(Date.now(), tz).date) return `Сегодня ${t}`;
    if (d === zonedParts(Date.now() + DAY, tz).date) return `Завтра ${t}`;
    const wd = new Date(ms).toLocaleDateString('ru-RU', { weekday: 'short', timeZone: tz });
    return `${wd[0].toUpperCase()}${wd.slice(1)} ${t}`;
  }

  async view(tenantId: string, userId: string, id: string) {
    const p = await this.repo.proposal(tenantId, id);
    if (!p) throw AppException.notFound('Предложение не найдено');
    if (!p.member_ids.map(String).includes(String(userId))) throw AppException.notFound('Предложение не найдено');
    const tz = await this.plus.timezoneOf(tenantId, userId);
    const names = await this.db.many<{ id: string; full_name: string }>(
      `SELECT id::text, full_name FROM users WHERE tenant_id = $1 AND id = ANY($2::bigint[])`, [tenantId, p.member_ids]);
    const ev = p.event_id ? await this.db.one<{ starts_at: Date; ends_at: Date; title: string }>(
      `SELECT starts_at, ends_at, title FROM calendar_events WHERE id = $1`, [p.event_id]) : null;
    const agenda = p.event_id ? await this.repo.agenda(tenantId, p.event_id) : null;
    const voted = new Set(Object.values(p.votes).flat().map(String));
    return {
      id: p.id, chatId: p.chat_id, status: p.status, topic: p.topic, minutes: p.minutes,
      isAuthor: String(p.author_id) === String(userId),
      members: names.map((n) => ({ id: n.id, name: n.full_name.split(' ')[0], voted: voted.has(n.id) })),
      slots: p.slots.map((s, i) => ({
        index: i, startsAt: s.startsAt, endsAt: s.endsAt, label: this.label(s.startsAt, tz),
        votes: (p.votes[String(i)] ?? []).length, mine: (p.votes[String(i)] ?? []).map(String).includes(String(userId)),
      })),
      event: ev && p.event_id ? {
        id: p.event_id, title: ev.title,
        label: `${this.label(ev.starts_at.toISOString(), tz)}–${ev.ends_at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz })}`,
        agenda: agenda?.body ?? null,
      } : null,
    };
  }

  private async broadcast(p: ProposalRow) {
    this.realtime.emitToUsers(p.tenant_id, p.member_ids.map(String), 'chat.proposal', { chatId: p.chat_id, proposalId: p.id });
  }

  /** Голос за слот (повторный щелчок снимает). Ответили все — назначаем самый популярный. */
  async vote(tenantId: string, userId: string, id: string, index: number) {
    const p = await this.repo.proposal(tenantId, id);
    if (!p || !p.member_ids.map(String).includes(String(userId))) throw AppException.notFound('Предложение не найдено');
    if (p.status !== 'open') throw AppException.conflict('Встреча уже назначена');
    if (!p.slots[index]) throw AppException.validation('Нет такого варианта');
    const votes: Record<string, string[]> = { ...p.votes };
    const key = String(index);
    const list = (votes[key] ?? []).map(String);
    votes[key] = list.includes(String(userId)) ? list.filter((x) => x !== String(userId)) : [...list, String(userId)];
    await this.repo.saveVotes(id, votes);
    const voted = new Set(Object.values(votes).flat().map(String));
    const everyone = p.member_ids.every((m) => voted.has(String(m)));
    if (everyone) {
      const best = p.slots.map((_, i) => i).sort((a, b) => (votes[String(b)]?.length ?? 0) - (votes[String(a)]?.length ?? 0) || a - b)[0];
      return this.schedule(tenantId, String(p.author_id), id, best, true);
    }
    await this.broadcast({ ...p, votes });
    return this.view(tenantId, userId, id);
  }

  /** «Назначить» — автор, или сами, когда проголосовали все. Встреча создаётся ровно один раз. */
  async schedule(tenantId: string, userId: string, id: string, index: number, auto = false) {
    const p = await this.repo.proposal(tenantId, id);
    if (!p || !p.member_ids.map(String).includes(String(userId))) throw AppException.notFound('Предложение не найдено');
    if (!auto && String(p.author_id) !== String(userId)) throw AppException.forbidden('Назначает тот, кто предложил встречу, — или когда проголосуют все');
    const slot = p.slots[index];
    if (!slot) throw AppException.validation('Нет такого варианта');
    if (!(await this.repo.claimSchedule(id))) throw AppException.conflict('Встреча уже назначена');
    const author = await this.db.one<{ role_code: string; full_name: string }>(`SELECT r.code AS role_code, u.full_name FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1`, [p.author_id]);
    const viewer = { userId: String(p.author_id), role: author?.role_code ?? 'member' };
    const lines = (await this.repo.chatLines(tenantId, p.chat_id, 15)).reverse();
    let topic = p.topic;
    let points: string[] = [];
    try {
      const raw = await this.ai.generate(tenantId, AGENDA_SYSTEM, lines.map((l) => `${l.author ?? ''}: ${l.body.slice(0, 300)}`).join('\n'), 'meeting_agenda');
      const j = JSON.parse(raw.replace(/^```json\s*|\s*```$/g, '').trim()) as { topic?: string; points?: string[] };
      if (!topic && typeof j.topic === 'string' && j.topic.trim()) topic = j.topic.trim().slice(0, 120);
      if (Array.isArray(j.points)) points = j.points.filter((x) => typeof x === 'string' && x.trim()).slice(0, 3);
    } catch { /* без модели — тема из правил, повестка из исходной фразы */ }
    const chat = await this.db.one<{ title: string | null }>(`SELECT title FROM chats WHERE id = $1`, [p.chat_id]);
    if (!topic) topic = chat?.title ?? null;
    const source = p.source_message_id ? lines.find((l) => l.id === p.source_message_id)?.body ?? null : null;
    if (!points.length && source) points = [source.slice(0, 200)];
    const agenda = [...points.map((x, i) => `${i + 1}. ${x}`), `${points.length + 1}. Кто и к какому сроку`].join('\n');
    let ev: { id: string; startsAt: string | Date };
    try {
      ev = await this.plus.createEvent(tenantId, viewer, {
        title: topic ? `Созвон: ${topic}` : 'Созвон', startsAt: slot.startsAt, endsAt: slot.endsAt,
        participantIds: p.member_ids.map(String), via: 'chat',
      }) as unknown as { id: string; startsAt: string | Date };
    } catch (e) {
      await this.repo.finishProposal(id, null, 'open');
      throw e;
    }
    await this.repo.finishProposal(id, String(ev.id), 'scheduled');
    await this.repo.setSourceChat(tenantId, String(ev.id), p.chat_id, p.source_message_id);
    await this.repo.saveAgenda(tenantId, String(ev.id), new Date(ev.startsAt), agenda, [{ kind: 'chat' }], null);
    const names = await this.db.many<{ full_name: string }>(`SELECT full_name FROM users WHERE id = ANY($1::bigint[]) ORDER BY full_name`, [p.member_ids]);
    const tz = await this.plus.timezoneOf(tenantId, String(p.author_id));
    const msg = await this.chats.addMessage({
      tenantId, chatId: p.chat_id, authorId: String(p.author_id), fileId: null, isAi: true,
      body: `✓ Встреча назначена: ${this.label(slot.startsAt, tz).toLowerCase()}–${new Date(slot.endsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit', timeZone: tz })} · ${names.map((n) => n.full_name.split(' ')[0]).join(', ')}\nПовестка: ${topic ? `«${topic}»` : agenda.split('\n')[0]} (из обсуждения)`,
    });
    await this.db.query(`UPDATE chat_messages SET proposal_id = $1 WHERE id = $2`, [id, msg.id]);
    this.realtime.emitToUsers(tenantId, p.member_ids.map(String), 'chat.message', { chatId: p.chat_id, message: { ...msg, proposal_id: id } });
    await this.broadcast(p);
    return this.view(tenantId, userId, id);
  }

  /** «Не предлагать в этом чате». */
  async mute(tenantId: string, userId: string, chatId: string) {
    await this.repo.dismiss(tenantId, userId, `chat:${chatId}`);
    return { muted: true };
  }
}
