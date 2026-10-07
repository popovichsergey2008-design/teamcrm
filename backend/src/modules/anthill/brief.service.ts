import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { localParts } from '../assistant/ping-rules';
import { tomorrowOf, zonedTime } from '../focus/close-day';
import { BotDelivery } from './bot-delivery.service';
import { briefDue, eveningText, morningText } from './brief-rules';
import { BriefRepository, PrefsRow } from './brief.repository';

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

  constructor(private readonly repo: BriefRepository, private readonly delivery: BotDelivery) {}

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

  /** Сводка прямо сейчас — для «Показать» в настройках: человек видит, что будет приходить. */
  async preview(tenantId: string, userId: string, kind: 'morning' | 'evening', tz: string | null): Promise<{ text: string }> {
    const text = await this.compose(tenantId, userId, kind, tz || FALLBACK_TZ, new Date());
    return { text: text ?? (kind === 'morning' ? 'Сегодня писать не о чем: встреч, сроков и ждущих решений нет.' : 'За сегодня писать не о чем.') };
  }

  private async compose(tenantId: string, userId: string, kind: 'morning' | 'evening', tz: string, now: Date): Promise<string | null> {
    const today = localParts(now, tz).date;
    const from = zonedTime(today, '00:00', tz);
    const to = zonedTime(tomorrowOf(now, tz), '00:00', tz);
    if (kind === 'morning') return morningText(await this.repo.morning(tenantId, userId, from, to), tz);
    return eveningText(await this.repo.evening(tenantId, userId, from, to));
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
