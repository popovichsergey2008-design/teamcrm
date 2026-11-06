import { Injectable } from '@nestjs/common';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { CalendarService } from '../calendar/calendar.service';
import { GuestLinksService } from '../media/guest-links.service';

type Answer = 'yes' | 'maybe' | 'no';

/**
 * Опрос времени (#4787, п. 15): когда во встрече внешние люди, общего календаря нет —
 * организатор предлагает варианты, гости отмечают «Подходит · Возможно · Не подходит»,
 * организатор выбирает итог. Перед назначением время проверяется ещё раз.
 */
@Injectable()
export class TimePollService {
  constructor(
    private readonly db: DbService,
    private readonly calendar: CalendarService,
    private readonly guests: GuestLinksService,
  ) {}

  private base() { return (process.env.APP_BASE_URL || 'https://app.qevo.one').replace(/\/+$/, ''); }
  private url(slug: string) { return `${this.base()}/book/poll/${slug}`; }

  async create(tenantId: string, userId: string, dto: { title: string; minutes: number; options: string[]; participantIds?: string[] }) {
    const title = String(dto.title ?? '').trim().slice(0, 255);
    if (!title) throw AppException.validation('Назовите встречу');
    const minutes = Math.round(Number(dto.minutes));
    if (!(minutes >= 5 && minutes <= 480)) throw AppException.validation('Продолжительность — от 5 минут до 8 часов');
    const options = [...new Set((dto.options ?? []).map((s) => Date.parse(s)).filter((t) => !Number.isNaN(t) && t > Date.now()))].sort().slice(0, 12);
    if (options.length < 2) throw AppException.validation('Предложите хотя бы два варианта времени в будущем');
    const slug = randomBytes(9).toString('base64url');
    const poll = await this.db.one<{ id: string }>(
      `INSERT INTO time_polls (tenant_id, user_id, title, duration_min, slug, participant_ids) VALUES ($1,$2,$3,$4,$5,$6::bigint[]) RETURNING id`,
      [tenantId, userId, title, minutes, slug, (dto.participantIds ?? []).map(String).slice(0, 50)],
    );
    for (const t of options) {
      await this.db.query(`INSERT INTO time_poll_options (poll_id, starts_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [poll!.id, new Date(t).toISOString()]);
    }
    return this.one(tenantId, userId, String(poll!.id));
  }

  private async tally(pollId: string) {
    const options = await this.db.many<{ id: string; starts_at: Date }>(`SELECT id::text, starts_at FROM time_poll_options WHERE poll_id = $1 ORDER BY starts_at`, [pollId]);
    const votes = await this.db.many<{ voter_name: string; voter_email: string | null; answers: Record<string, Answer> }>(
      `SELECT voter_name, voter_email, answers FROM time_poll_votes WHERE poll_id = $1 ORDER BY created_at`, [pollId]);
    return {
      options: options.map((o) => {
        const count = (a: Answer) => votes.filter((v) => v.answers?.[o.id] === a).length;
        return { id: o.id, startsAt: o.starts_at.toISOString(), yes: count('yes'), maybe: count('maybe'), no: count('no') };
      }),
      votes: votes.map((v) => ({ name: v.voter_name, email: v.voter_email, answers: v.answers })),
    };
  }

  async one(tenantId: string, userId: string, id: string) {
    const p = await this.db.one<any>(`SELECT * FROM time_polls WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, userId, id]);
    if (!p) throw AppException.notFound('Опрос не найден');
    return {
      id: String(p.id), title: p.title, minutes: p.duration_min, status: p.status, url: this.url(p.slug),
      eventId: p.event_id ? String(p.event_id) : null, ...(await this.tally(String(p.id))),
    };
  }

  async list(tenantId: string, userId: string) {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id::text FROM time_polls WHERE tenant_id = $1 AND user_id = $2 AND created_at > now() - interval '60 days' ORDER BY created_at DESC LIMIT 20`,
      [tenantId, userId]);
    return Promise.all(rows.map((r) => this.one(tenantId, userId, r.id)));
  }

  /** Организатор выбрал итог: встреча с повторной проверкой занятости, гости — приглашения. */
  async decide(tenantId: string, user: { userId: string; role: string }, id: string, optionId: string) {
    const p = await this.db.one<any>(`SELECT * FROM time_polls WHERE tenant_id = $1 AND user_id = $2 AND id = $3`, [tenantId, user.userId, id]);
    if (!p) throw AppException.notFound('Опрос не найден');
    if (p.status !== 'open') throw AppException.conflict('Итог по этому опросу уже выбран');
    const opt = await this.db.one<{ starts_at: Date }>(`SELECT starts_at FROM time_poll_options WHERE poll_id = $1 AND id = $2`, [p.id, optionId]);
    if (!opt) throw AppException.notFound('Вариант не найден');
    const startsAt = opt.starts_at.toISOString();
    const endsAt = new Date(opt.starts_at.getTime() + p.duration_min * 60_000).toISOString();
    // время могло заняться, пока шёл опрос: у организатора — проверяем сами, у участников — проверит создание встречи
    const mine = (await this.calendar.busy(tenantId, [user.userId], startsAt, endsAt)).busy[user.userId] ?? [];
    if (mine.some((b) => b.kind !== 'all_day')) throw AppException.conflict('Это время у вас уже занято — выберите другой вариант');
    const participantIds = ((p.participant_ids ?? []) as unknown[]).map(String).filter((x) => x !== String(user.userId));
    const ev = await this.calendar.create(tenantId, user, {
      title: p.title, startsAt, endsAt, scope: 'personal', participantIds, isCall: true, reminders: [10, 5, 0], // #4766: за 10, за 5 минут и в момент начала
    } as Parameters<CalendarService['create']>[2]);
    const votes = await this.db.many<{ voter_name: string; voter_email: string | null; answers: Record<string, Answer> }>(
      `SELECT voter_name, voter_email, answers FROM time_poll_votes WHERE poll_id = $1`, [p.id]);
    for (const v of votes) {
      if (v.voter_email && v.answers?.[optionId] !== 'no') {
        await this.guests.inviteGuest({ userId: user.userId, tenantId }, String(ev.id), v.voter_email, v.voter_name).catch(() => undefined);
      }
    }
    await this.db.query(`UPDATE time_polls SET status = 'decided', event_id = $2 WHERE id = $1`, [p.id, ev.id]);
    return this.one(tenantId, user.userId, id);
  }

  // ── для гостя ──

  async page(slug: string) {
    const p = await this.db.one<any>(
      `SELECT tp.*, u.full_name AS owner_name, t.name AS tenant_name FROM time_polls tp
         JOIN users u ON u.id = tp.user_id JOIN tenants t ON t.id = tp.tenant_id WHERE tp.slug = $1`, [slug]);
    if (!p) throw AppException.notFound('Опрос не найден');
    const t = await this.tally(String(p.id));
    return {
      title: p.title, minutes: p.duration_min, status: p.status, organizer: { name: p.owner_name, company: p.tenant_name },
      options: t.options.map((o) => ({ id: o.id, startsAt: o.startsAt, yes: o.yes, maybe: o.maybe })),
      voters: t.votes.length,
    };
  }

  async vote(slug: string, dto: { name: string; email?: string; answers: Record<string, string> }) {
    const p = await this.db.one<any>(`SELECT id, status FROM time_polls WHERE slug = $1`, [slug]);
    if (!p) throw AppException.notFound('Опрос не найден');
    if (p.status !== 'open') throw AppException.conflict('Организатор уже выбрал время — опрос закрыт');
    const name = String(dto.name ?? '').trim().slice(0, 120);
    if (!name) throw AppException.validation('Укажите имя');
    const email = String(dto.email ?? '').trim().toLowerCase().slice(0, 320) || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw AppException.validation('Проверьте адрес почты');
    const ids = new Set((await this.db.many<{ id: string }>(`SELECT id::text FROM time_poll_options WHERE poll_id = $1`, [p.id])).map((o) => o.id));
    const answers: Record<string, Answer> = {};
    for (const [k, v] of Object.entries(dto.answers ?? {})) if (ids.has(k) && (v === 'yes' || v === 'maybe' || v === 'no')) answers[k] = v;
    if (!Object.keys(answers).length) throw AppException.validation('Отметьте хотя бы один вариант');
    const key = createHash('sha256').update((email ?? name).toLowerCase()).digest('hex').slice(0, 64);
    await this.db.query(
      `INSERT INTO time_poll_votes (poll_id, voter_key, voter_name, voter_email, answers) VALUES ($1,$2,$3,$4,$5::jsonb)
       ON CONFLICT (poll_id, voter_key) DO UPDATE SET voter_name = EXCLUDED.voter_name, voter_email = EXCLUDED.voter_email,
         answers = EXCLUDED.answers, updated_at = now()`,
      [p.id, key, name, email, JSON.stringify(answers)],
    );
    return this.page(slug);
  }
}
