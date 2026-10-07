import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { BotDelivery } from './bot-delivery.service';
import { briefDue, eveningText, morningText } from './brief-rules';
import { BriefRepository, PrefsRow } from './brief.repository';
import { ModeratorRepository } from '../assistant/moderator.repository';
import { CalendarService } from '../calendar/calendar.service';
import { meetingBriefText, weekAuditText } from './meeting-brief-rules';
import { classify, unansweredText } from './chat-digest-rules';
import { MailboxService } from '../mailbox/mailbox.service';

const FALLBACK_TZ = 'Europe/Moscow';
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface SecretaryPrefs {
  morningAt: string | null;
  eveningAt: string | null;
  weekdaysOnly: boolean;
  channels: { push: boolean; telegram: boolean };
  meetingBriefMin: number | null;
  vipUserIds: string[];
}

/**
 * Личные сводки секретаря (ТЗ-18, §10.3–10.4, §21): утром — что сегодня, вечером —
 * что сделано и что завтра. Время и канал выбирает сам человек; по умолчанию
 * выключено — секретарь не начинает писать всем подряд.
 */
@Injectable()
export class BriefService {
  private readonly log = new Logger('SecretaryBrief');

  constructor(
    private readonly repo: BriefRepository,
    private readonly delivery: BotDelivery,
    private readonly moderator: ModeratorRepository,
    private readonly calendar: CalendarService,
    private readonly mail: MailboxService,
  ) {}

  async prefs(userId: string): Promise<SecretaryPrefs> {
    return view(await this.repo.prefs(userId));
  }

  async savePrefs(tenantId: string, userId: string, p: Partial<SecretaryPrefs>): Promise<SecretaryPrefs> {
    const cur = view(await this.repo.prefs(userId));
    const time = (v: string | null | undefined, old: string | null) => {
      if (v === undefined) return old;
      if (v === null || v === '') return null;
      if (!HHMM.test(v)) throw AppException.validation('Время — в виде ЧЧ:ММ, например 08:30');
      return v;
    };
    const next: SecretaryPrefs = {
      morningAt: time(p.morningAt, cur.morningAt),
      eveningAt: time(p.eveningAt, cur.eveningAt),
      weekdaysOnly: p.weekdaysOnly ?? cur.weekdaysOnly,
      channels: { push: p.channels?.push ?? cur.channels.push, telegram: p.channels?.telegram ?? cur.channels.telegram },
      meetingBriefMin: p.meetingBriefMin === undefined ? cur.meetingBriefMin
        : p.meetingBriefMin === null ? null : Math.min(240, Math.max(5, Math.round(Number(p.meetingBriefMin) || 30))),
      vipUserIds: (p.vipUserIds ?? cur.vipUserIds).map(String).filter((x) => /^\d+$/.test(x)).slice(0, 50),
    };
    await this.repo.savePrefs(tenantId, userId, next);
    return next;
  }

  /** Непрочитанное для сводки переписки — бот и утренняя сводка считают одинаково. */
  digest(tenantId: string, userId: string) {
    return this.repo.digestRows(tenantId, userId);
  }

  unanswered(tenantId: string, userId: string, days = 3) {
    return this.repo.unanswered(tenantId, userId, days);
  }

  /** Сводка прямо сейчас — для «Показать» в настройках: человек видит, что будет приходить. */
  async preview(tenantId: string, userId: string, kind: 'morning' | 'evening', tz: string | null): Promise<{ text: string }> {
    const text = await this.compose(tenantId, userId, kind, tz || FALLBACK_TZ, new Date());
    return { text: text ?? (kind === 'morning' ? 'Сегодня писать не о чем: встреч, сроков и ждущих решений нет.' : 'За сегодня писать не о чем.') };
  }

  private async compose(tenantId: string, userId: string, kind: 'morning' | 'evening', tz: string, now: Date): Promise<string | null> {
    const today = localParts(now, tz).date;
    const from = zonedTime(today, '00:00', tz);
    const to = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    if (kind === 'morning') {
      const base = morningText(await this.repo.morning(tenantId, userId, from, to), tz);
      // переписка (§8.3–8.4): что срочного и кто не ответил на мои вопросы
      const d = classify(await this.repo.digestRows(tenantId, userId));
      const silent = unansweredText(await this.repo.unanswered(tenantId, userId, 3));
      const extra: string[] = [];
      if (d.critical.length) extra.push(`Срочное в переписке: ${d.critical.length} — спросите QEVO Bot «что срочного в чатах»`);
      if (silent) extra.push(`Вам не ответили:\n${silent}`);
      const mailLine = await this.mail.briefLine(userId).catch(() => null);
      if (mailLine) extra.push(mailLine);
      const all = [base, ...extra].filter(Boolean);
      return all.length ? all.join('\n') : null;
    }
    const evening = eveningText(await this.repo.evening(tenantId, userId, from, to));
    // в последний рабочий день недели к итогам дня — итоги недели (§7.4)
    if (!(await this.lastWorkday(tenantId, now, tz))) return evening;
    const week = await this.weekAudit(tenantId, userId, tz, now);
    if (!week) return evening;
    return evening ? `${evening}\n\nНеделя:\n${week}` : `Неделя:\n${week}`;
  }

  /** Сегодня последний рабочий день недели: следующие дни до понедельника — выходные. */
  private async lastWorkday(tenantId: string, now: Date, tz: string): Promise<boolean> {
    const work = await this.calendar.work(tenantId);
    const dow = localParts(now, tz).dow;
    if (work.weekendDays.includes(dow)) return false;
    for (let d = dow + 1; d <= 7; d += 1) {
      const wd = d % 7;
      if (wd === 1) return true; // дошли до понедельника, рабочих по пути не было
      if (!work.weekendDays.includes(wd)) return false;
    }
    return true;
  }

  /**
   * Аудит недели: с понедельника по сегодня в поясе человека. Рабочие часы — по
   * календарю компании: доля встреч считается от них, а не от суток.
   */
  async weekAudit(tenantId: string, userId: string, tz: string, now = new Date()): Promise<string | null> {
    const work = await this.calendar.work(tenantId);
    const local = localParts(now, tz);
    const monday = shiftDate(local.date, -((local.dow + 6) % 7));
    const from = zonedTime(monday, '00:00', tz);
    const to = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    let days = 0;
    for (let d = monday; d <= local.date; d = shiftDate(d, 1)) {
      const dow = new Date(`${d}T12:00:00Z`).getUTCDay();
      if (!work.weekendDays.includes(dow) && !work.holidays.includes(d)) days += 1;
    }
    const [sh, sm] = work.workStart.split(':').map(Number);
    const [eh, em] = work.workEnd.split(':').map(Number);
    const dayHours = Math.max(0, (eh * 60 + em - sh * 60 - sm) / 60);
    return weekAuditText({ workHours: days * dayHours, ...(await this.repo.week(tenantId, userId, from, to)) });
  }

  /**
   * Справки перед встречей (§7.3): тем, кто включил, за выбранное число минут.
   * Факты — те же, что у модератора встреч; без фактов справки нет.
   */
  async meetingTick(): Promise<void> {
    const due = await this.repo.dueMeetingBriefs();
    for (const m of due) {
      const ref = `${m.event_id}:${Math.floor(new Date(m.starts_at).getTime() / 1000)}`;
      if (!(await this.repo.claimSent(String(m.user_id), 'meeting_brief', ref))) continue;
      try {
        const people = await this.repo.eventParticipants(String(m.event_id));
        const ids = people.map((p) => String(p.user_id));
        const [decisions, overdue, approvals, review] = await Promise.all([
          this.moderator.previousDecisions(String(m.tenant_id), String(m.event_id)),
          this.moderator.overdue(String(m.tenant_id), ids),
          this.moderator.approvals(String(m.tenant_id), ids),
          this.moderator.awaitingReview(String(m.tenant_id), ids),
        ]);
        const text = meetingBriefText({
          title: m.title, startsAt: new Date(m.starts_at),
          participants: people.filter((p) => String(p.user_id) !== String(m.user_id)).map((p) => p.full_name),
          client: m.client, description: m.description, decisions, overdue, approvals, review,
        }, Number(m.minutes));
        if (!text) continue;
        await this.delivery.send(String(m.tenant_id), String(m.user_id), {
          eventKey: 'secretary.meeting', title: '📋 Перед встречей', body: text,
          path: m.public_id ? `/meet/${m.public_id}` : '/focus/calendar',
          channels: { push: m.channels?.push !== false, telegram: m.channels?.telegram !== false },
        });
      } catch (e) {
        this.log.warn(`справка перед встречей ${m.event_id} для ${m.user_id}: ${(e as Error).message}`);
      }
    }
  }

  /** Проход планировщика: раз в минуту, сводки тем, у кого подошло время. */
  async tick(now = new Date()): Promise<void> {
    const rows = await this.repo.scheduled();
    for (const r of rows) {
      const tz = r.timezone || FALLBACK_TZ;
      const local = localParts(now, tz);
      for (const kind of ['morning', 'evening'] as const) {
        const at = kind === 'morning' ? r.morning_at : r.evening_at;
        const last = kind === 'morning' ? r.last_morning : r.last_evening;
        if (!briefDue(at, local, last, r.weekdays_only)) continue;
        if (!(await this.repo.claim(String(r.user_id), kind, local.date))) continue;
        try {
          const text = await this.compose(String(r.tenant_id), String(r.user_id), kind, tz, now);
          if (!text) continue; // писать не о чем — молчим, но день отмечен: не будем пытаться снова
          await this.delivery.send(String(r.tenant_id), String(r.user_id), {
            eventKey: `secretary.${kind}`,
            title: kind === 'morning' ? '☀️ Ваш день' : '🌙 Итоги дня',
            body: text,
            path: '/focus',
            channels: { push: r.channels?.push !== false, telegram: r.channels?.telegram !== false },
          });
        } catch (e) {
          this.log.warn(`сводка ${kind} для ${r.user_id}: ${(e as Error).message}`);
        }
      }
    }
  }
}

function shiftDate(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function view(r: PrefsRow | null): SecretaryPrefs {
  return {
    morningAt: r?.morning_at ?? null,
    eveningAt: r?.evening_at ?? null,
    weekdaysOnly: r?.weekdays_only ?? true,
    channels: { push: r?.channels?.push !== false, telegram: r?.channels?.telegram !== false },
    meetingBriefMin: r?.meeting_brief_min ?? null,
    vipUserIds: (r?.vip_user_ids ?? []).map(String),
  };
}
