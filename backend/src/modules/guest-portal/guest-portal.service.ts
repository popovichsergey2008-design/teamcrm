import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { PromptsService } from '../prompts/prompts.service';
import { PushService } from '../notifications/push.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { GuestLinksRepository } from '../media/guest-links.repository';
import { GuestSessionsRepository } from '../media/guest-sessions.repository';
import { buildIcs } from '../calendar/ics';
import { BrandRow, GuestPortalRepository, MeetingRow, PublishedSummary, SummaryRow } from './guest-portal.repository';
import {
  AgreementSide, draftAgreements, googleCalendarUrl, guestLanguage, normalizeHex, outlookCalendarUrl, parseModelDraft,
  postcallState, rulesSummary, safeAccent, SIDES,
} from './guest-rules';

export type HostUser = { tenantId: string; userId: string; role: string };
type Cred = { tenantId: string; linkId: string; roomId: string; sessionId: string | null; name: string; email: string | null; viaInvite: boolean };

const MODEL_TIMEOUT_MS = 30_000;
const SYSTEM_FALLBACK = 'Напиши для внешнего клиента 2–5 предложений об итогах встречи: о чём договорились и что дальше. Без внутренних рисков, денег и заметок. Верни JSON {"summary": "...", "agreements": [...]}.';

/**
 * Гостевой портал (ТЗ-28): бренд, протокол встречи для клиента, подтверждения.
 *
 * Главное правило (п. 30–32, 101): гость видит только то, что хозяин посмотрел и
 * опубликовал, — `published_json` и явно выбранные файлы. Черновик пишет модель
 * (решение заказчика 12.10) из того же, что во внутреннем разборе, — решений и
 * поручений встречи; публикует всегда человек.
 */
@Injectable()
export class GuestPortalService {
  private readonly log = new Logger('GuestPortal');

  constructor(
    private readonly repo: GuestPortalRepository,
    private readonly links: GuestLinksRepository,
    private readonly sessions: GuestSessionsRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly push: PushService,
    private readonly crypto: IntegrationCryptoService,
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  private baseUrl() {
    return (this.config.get<string>('APP_BASE_URL') || 'https://qevo.one').replace(/\/+$/, '');
  }

  // ── бренд ──

  /** Бренд для гостевой страницы — без внутренних полей; логотип по короткой подписанной ссылке. */
  brandView(b: BrandRow) {
    return {
      companyName: b.company_name || b.tenant_name,
      logoUrl: b.logo_file_id ? this.files.signPlay(b.tenant_id, b.logo_file_id, 86_400).url : null,
      accent: safeAccent(b.accent),
      background: b.background,
      welcomeText: b.welcome_text,
      footerText: b.footer_text,
      poweredBy: b.powered_by,
      recordingNotice: b.recording_notice,
      consentRequired: b.consent_required,
    };
  }

  async brandFor(q: { publicId?: string; token?: string; session?: string }) {
    let tenantId: string | null = null;
    if (q.publicId) tenantId = (await this.links.meetingByPublicId(String(q.publicId).slice(0, 16)))?.tenant_id ?? null;
    else if (q.token) tenantId = (await this.links.findByHash(sha256(String(q.token))))?.tenant_id ?? null;
    else if (q.session) tenantId = (await this.sessions.byKey(String(q.session)))?.tenant_id ?? null;
    if (!tenantId) return null;
    const b = await this.repo.brand(String(tenantId));
    return b ? this.brandView(b) : null;
  }

  async brandSettings(tenantId: string) {
    const b = await this.repo.brand(tenantId);
    if (!b) throw AppException.notFound('Организация не найдена');
    return {
      companyName: b.company_name, logoFileId: b.logo_file_id, accent: b.accent, background: b.background,
      welcomeText: b.welcome_text, footerText: b.footer_text, poweredBy: b.powered_by,
      recordingNotice: b.recording_notice, consentRequired: b.consent_required, summaryDays: b.summary_days,
      tenantName: b.tenant_name,
      preview: this.brandView(b),
    };
  }

  async saveBrand(tenantId: string, p: Partial<{
    companyName: string | null; logoFileId: string | null; accent: string | null; background: string; welcomeText: string | null;
    footerText: string | null; poweredBy: boolean; recordingNotice: boolean; consentRequired: boolean; summaryDays: number;
  }>) {
    const cur = await this.repo.brand(tenantId);
    if (!cur) throw AppException.notFound('Организация не найдена');
    const txt = (v: string | null | undefined, max: number, keep: string | null) => (v === undefined ? keep : (v ?? '').trim().slice(0, max) || null);
    if (p.accent && !normalizeHex(p.accent)) throw AppException.validation('Цвет — в виде #RRGGBB');
    if (p.logoFileId) {
      const f = await this.files.meta(tenantId, p.logoFileId);
      if (!f || !/^image\/(png|jpeg|webp|gif)$/.test(f.content_type)) throw AppException.validation('Логотип — картинка PNG, JPG, WEBP или GIF');
    }
    await this.repo.saveBrand(tenantId, {
      companyName: txt(p.companyName, 120, cur.company_name),
      logoFileId: p.logoFileId === undefined ? cur.logo_file_id : p.logoFileId,
      accent: p.accent === undefined ? cur.accent : normalizeHex(p.accent),
      background: p.background && ['plain', 'soft', 'gradient'].includes(p.background) ? p.background : cur.background,
      welcomeText: txt(p.welcomeText, 400, cur.welcome_text),
      footerText: txt(p.footerText, 200, cur.footer_text),
      poweredBy: p.poweredBy ?? cur.powered_by,
      recordingNotice: p.recordingNotice ?? cur.recording_notice,
      consentRequired: p.consentRequired ?? cur.consent_required,
      summaryDays: p.summaryDays && p.summaryDays >= 1 && p.summaryDays <= 365 ? Math.round(p.summaryDays) : cur.summary_days,
    });
    return this.brandSettings(tenantId);
  }

  // ── гость ──

  /** Кто пришёл: персональная ссылка из письма или гостевая сессия вошедшего (решение 12.10). */
  private async resolve(c: { token?: string; session?: string }): Promise<Cred> {
    if (c.session) {
      const s = await this.sessions.byKey(String(c.session));
      if (s) return { tenantId: s.tenant_id, linkId: s.link_id, roomId: s.room_id, sessionId: s.id, name: s.name, email: s.email, viaInvite: false };
    }
    if (c.token) {
      const l = await this.links.findByHash(sha256(String(c.token)));
      // отозванная ссылка закрывает и протокол (п. 18); истёкший вход — нет: итоги живут дольше (п. 19)
      if (l && !l.revoked_at && l.invite_email) {
        return {
          tenantId: String(l.tenant_id), linkId: String(l.id), roomId: l.room_id, sessionId: null,
          name: l.invite_name || l.invite_email, email: l.invite_email, viaInvite: true,
        };
      }
    }
    throw AppException.unauthorized('Доступ к итогам встречи закрыт');
  }

  /** Экран после встречи (п. 28–29): «готовим протокол» или опубликованная версия. */
  async postcall(c: { token?: string; session?: string }, now = new Date()) {
    const g = await this.resolve(c);
    const [brand, meeting, event] = await Promise.all([
      this.repo.brand(g.tenantId), this.repo.meetingOfRoom(g.tenantId, g.roomId), this.repo.eventOfRoom(g.tenantId, g.roomId),
    ]);
    const summary = meeting ? await this.repo.summaryOf(g.tenantId, meeting.id) : null;
    const pub = summary?.status === 'published' ? summary.published_json : null;
    const state = postcallState({
      publishedAt: pub ? new Date(pub.publishedAt) : null,
      summaryDays: brand?.summary_days ?? 30,
      meetingHappened: !!meeting || !!g.sessionId,
      now,
    });
    const base = {
      state,
      guestName: g.name,
      brand: brand ? this.brandView(brand) : null,
      meeting: { title: event?.title ?? meeting?.title ?? 'Встреча', at: (event?.starts_at ?? meeting?.happened_at ?? null) as Date | null, organizer: event?.organizer_name ?? null },
    };
    if (state !== 'ready' || !pub || !summary) return { ...base, summary: null, acknowledgedAt: null };
    const viewedFirst = await this.repo.eventOnce(g.tenantId, { linkId: g.linkId, sessionId: g.sessionId, summaryId: summary.id, event: 'summary_viewed' }).catch(() => false);
    if (viewedFirst && meeting?.client_id) {
      await this.repo.clientActivity(g.tenantId, meeting.client_id, `${g.name} открыл(а) итоги встречи «${base.meeting.title}»`, meeting.id).catch(() => undefined);
    }
    const files = (await this.repo.files(summary.id)).filter((f) => pub.files.includes(f.file_id));
    const next = pub.nextMeeting;
    const nextEnd = next ? new Date(new Date(next.at).getTime() + 60 * 60_000) : null;
    return {
      ...base,
      summary: {
        version: pub.version,
        updated: pub.version > 1,
        publishedAt: pub.publishedAt,
        language: pub.language,
        text: pub.summary,
        agreements: pub.agreements,
        files: files.map((f) => ({ id: f.file_id, name: f.file_name, size: Number(f.size_bytes), canDownload: f.can_download })),
        nextMeeting: next ? {
          ...next,
          google: googleCalendarUrl({ title: next.title, startsAt: new Date(next.at), endsAt: nextEnd!, details: next.url }),
          outlook: outlookCalendarUrl({ title: next.title, startsAt: new Date(next.at), endsAt: nextEnd!, details: next.url }),
        } : null,
      },
      acknowledgedAt: await this.repo.acknowledged(summary.id, pub.version, { sessionId: g.sessionId, linkId: g.sessionId ? null : g.linkId }),
    };
  }

  private async published(g: Cred): Promise<{ meeting: MeetingRow; summary: SummaryRow; pub: PublishedSummary }> {
    const meeting = await this.repo.meetingOfRoom(g.tenantId, g.roomId);
    const summary = meeting ? await this.repo.summaryOf(g.tenantId, meeting.id) : null;
    if (!meeting || !summary || summary.status !== 'published' || !summary.published_json) throw AppException.notFound('Итоги встречи ещё не опубликованы');
    return { meeting, summary, pub: summary.published_json };
  }

  /** «Подтвердить договорённости» (п. 36): отметка на текущую версию. */
  async acknowledge(c: { token?: string; session?: string }, version: number) {
    const g = await this.resolve(c);
    const { meeting, summary, pub } = await this.published(g);
    if (version !== pub.version) throw AppException.conflict('Итоги обновились — посмотрите новую версию');
    const who = { sessionId: g.sessionId, linkId: g.sessionId ? null : g.linkId };
    if (!(await this.repo.acknowledged(summary.id, pub.version, who))) {
      await this.repo.addFeedback({ tenantId: g.tenantId, summaryId: summary.id, sessionId: g.sessionId, linkId: g.linkId, name: g.name, kind: 'confirmed', body: null, version: pub.version });
      await this.repo.event(g.tenantId, { linkId: g.linkId, sessionId: g.sessionId, summaryId: summary.id, event: 'acknowledged' });
      await this.notifyHost(g, meeting, summary, `${g.name} подтвердил(а) договорённости`, `Встреча «${meeting.title}»`);
      if (meeting.client_id) await this.repo.clientActivity(g.tenantId, meeting.client_id, `${g.name} подтвердил(а) договорённости встречи «${meeting.title}»`, meeting.id).catch(() => undefined);
    }
    return { acknowledged: true };
  }

  /** «Есть уточнение» / вопрос (п. 37–39): хозяину приходит уведомление. */
  async feedback(c: { token?: string; session?: string }, kind: string, body: string) {
    const g = await this.resolve(c);
    const { meeting, summary, pub } = await this.published(g);
    const text = String(body || '').trim().slice(0, 2000);
    if (text.length < 2) throw AppException.validation('Напишите, что уточнить');
    await this.repo.addFeedback({ tenantId: g.tenantId, summaryId: summary.id, sessionId: g.sessionId, linkId: g.linkId, name: g.name, kind, body: text, version: pub.version });
    await this.repo.event(g.tenantId, { linkId: g.linkId, sessionId: g.sessionId, summaryId: summary.id, event: 'feedback' });
    const what = kind === 'correction' ? 'предложил(а) уточнение к итогам встречи' : kind === 'question' ? 'задал(а) вопрос по итогам встречи' : 'оставил(а) комментарий к итогам встречи';
    await this.notifyHost(g, meeting, summary, `Клиент ${g.name} ${what}`, text.slice(0, 160));
    if (meeting.client_id) await this.repo.clientActivity(g.tenantId, meeting.client_id, `${g.name} ${what} «${meeting.title}»`, meeting.id, { kind }).catch(() => undefined);
    return { saved: true };
  }

  private async notifyHost(g: Cred, meeting: MeetingRow, summary: SummaryRow, title: string, body: string) {
    const host = summary.published_by ?? meeting.created_by;
    if (!host) return;
    await this.push.personal({ tenantId: g.tenantId, userId: host, eventKey: 'meeting.guest_feedback', title, body, path: `/meetings/${meeting.id}/postcall` }).catch(() => false);
  }

  /** Файл гостю — только из опубликованного списка и по короткой подписанной ссылке (п. 45–46). */
  async file(c: { token?: string; session?: string }, fileId: string) {
    const g = await this.resolve(c);
    const { summary, pub } = await this.published(g);
    const f = (await this.repo.files(summary.id)).find((x) => x.file_id === String(fileId) && pub.files.includes(x.file_id));
    if (!f) throw AppException.notFound('Файл не найден');
    await this.repo.event(g.tenantId, { linkId: g.linkId, sessionId: g.sessionId, summaryId: summary.id, event: 'file_downloaded' }).catch(() => undefined);
    return this.files.signPlay(g.tenantId, f.file_id, 300);
  }

  /** Следующая встреча файлом .ics (п. 43). */
  async ics(c: { token?: string; session?: string }): Promise<string> {
    const g = await this.resolve(c);
    const { summary, pub } = await this.published(g);
    if (!pub.nextMeeting) throw AppException.notFound('Следующей встречи нет');
    const at = new Date(pub.nextMeeting.at);
    return buildIcs({
      uid: `guest-next-${summary.id}-${at.getTime()}@qevo.one`, title: pub.nextMeeting.title, description: pub.nextMeeting.url, location: pub.nextMeeting.url,
      startsAt: at, endsAt: new Date(at.getTime() + 60 * 60_000), allDay: false, method: 'PUBLISH', url: pub.nextMeeting.url,
    });
  }

  /** Событие гостя без слежки (п. 80–81): открыл, проверил устройства, добавил в календарь, нажал «что такое QEVO». */
  async track(q: { token?: string; session?: string; publicId?: string }, event: string) {
    let tenantId: string | null = null;
    let linkId: string | null = null;
    let sessionId: string | null = null;
    if (q.session || q.token) {
      const g = await this.resolve(q).catch(() => null);
      if (g) { tenantId = g.tenantId; linkId = g.linkId; sessionId = g.sessionId; }
    }
    if (!tenantId && q.publicId) {
      const l = await this.links.meetingByPublicId(String(q.publicId).slice(0, 16));
      if (l) { tenantId = String(l.tenant_id); linkId = String(l.id); }
    }
    if (!tenantId && q.token) {
      const l = await this.links.findByHash(sha256(String(q.token)));
      if (l && !l.revoked_at) { tenantId = String(l.tenant_id); linkId = String(l.id); }
    }
    if (tenantId) await this.repo.event(tenantId, { linkId, sessionId, event });
    return { saved: true };
  }

  // ── хозяин ──

  private async hostMeeting(u: HostUser, meetingId: string) {
    const meeting = await this.repo.meeting(u.tenantId, meetingId);
    if (!meeting) throw AppException.notFound('Встреча не найдена');
    const boss = u.role === 'owner' || u.role === 'manager';
    if (!boss && !(await this.repo.canHost(u.tenantId, meetingId, u.userId))) {
      throw AppException.forbidden('Клиентский протокол ведёт организатор встречи');
    }
    return meeting;
  }

  /** Панель «Клиентский протокол» на экране итогов (п. 33). */
  async hostView(u: HostUser, meetingId: string) {
    const meeting = await this.hostMeeting(u, meetingId);
    const [summary, guests, event] = await Promise.all([
      this.repo.summaryOf(u.tenantId, meetingId),
      meeting.room_id ? this.repo.guests(u.tenantId, meeting.room_id) : Promise.resolve([]),
      meeting.room_id ? this.repo.eventOfRoom(u.tenantId, meeting.room_id) : Promise.resolve(null),
    ]);
    // протокол нужен, когда есть кому его показать: гости встречи или клиент (п. 91)
    const eligible = guests.length > 0 || !!meeting.client_id;
    const [agreements, files, feedback] = summary
      ? await Promise.all([this.repo.agreements(summary.id), this.repo.files(summary.id), this.repo.feedbackOf(summary.id)])
      : [[], [], []];
    return {
      eligible,
      canPublishTo: guests.filter((x) => !x.revoked && x.email).length,
      guests: guests.map((x) => ({ kind: x.kind, name: x.name, email: x.email, revoked: x.revoked })),
      meetingUrl: event?.public_id ? `${this.baseUrl()}/meet/${event.public_id}` : null,
      summary: summary ? {
        id: summary.id,
        status: summary.status,
        version: summary.version,
        dirty: summary.dirty,
        language: summary.language,
        text: summary.summary_text,
        draftModel: summary.draft_model,
        publishedAt: summary.published_at,
        nextMeeting: summary.next_meeting_at ? { title: summary.next_meeting_title ?? 'Встреча', at: summary.next_meeting_at, url: summary.next_meeting_url } : null,
        agreements: agreements.map((a) => ({ text: a.text, side: a.owner_side, deadlineAt: a.deadline_at, fromDecision: !!a.source_decision_id, fromTask: !!a.source_draft_id })),
        files: files.map((f) => ({ id: f.file_id, name: f.file_name, size: Number(f.size_bytes) })),
        feedback: feedback.map((f) => ({ id: f.id, name: f.guest_name, kind: f.kind, body: f.body, version: f.version, handledAt: f.handled_at, at: f.created_at })),
      } : null,
    };
  }

  /**
   * Черновик клиентского протокола (п. 31): договорённости — из решений и поручений
   * встречи, текст «Кратко» — моделью на языке клиента, с проверкой, что даты и
   * числа в переводе не поплыли. Без ключа ИИ — текст правилами. Публикует человек.
   */
  async draft(u: HostUser, meetingId: string, opts: { language?: string } = {}) {
    const meeting = await this.hostMeeting(u, meetingId);
    const existing = await this.repo.summaryOf(u.tenantId, meetingId);
    const language = guestLanguage(opts.language ?? existing?.language ?? (await this.guestLanguageOf(u.tenantId, meeting.room_id)));
    const src = await this.repo.sources(u.tenantId, meetingId);
    const agreements = draftAgreements(src.decisions, src.drafts.map((d) => ({ id: d.id, title: d.title, deadlineAt: d.deadline_at, status: d.status, assigneeId: d.assignee_id })));
    let text = rulesSummary(meeting.title, agreements, language);
    let model: string | null = null;
    const polished = await this.modelDraft(u, meeting.title, language, src, agreements.map((a) => a.text)).catch((e) => {
      this.log.warn(`черновик протокола ${meetingId}: ${(e as Error).message}`);
      return null;
    });
    if (polished) {
      text = polished.summary;
      model = polished.model;
      if (polished.agreements) polished.agreements.forEach((t, i) => { agreements[i].text = t; });
    }
    if (existing) {
      await this.repo.resetDraft(existing.id, u.tenantId, { language, text, model, agreements });
    } else {
      const next = meeting.room_id ? await this.repo.nextMeeting(u.tenantId, meeting.room_id, new Date()) : null;
      await this.repo.createSummary({
        tenantId: u.tenantId, meetingId, roomId: meeting.room_id, language, text, model,
        next: next ? { title: next.title, at: next.starts_at, url: next.public_id ? `${this.baseUrl()}/meet/${next.public_id}` : null } : null,
        agreements,
      });
    }
    return this.hostView(u, meetingId);
  }

  private async guestLanguageOf(tenantId: string, roomId: string | null): Promise<string> {
    if (!roomId) return 'ru';
    const r = await this.db.one<{ language: string | null }>(
      `SELECT language FROM guest_sessions WHERE tenant_id = $1 AND room_id = $2 AND language IS NOT NULL
        GROUP BY language ORDER BY count(*) DESC LIMIT 1`,
      [tenantId, roomId],
    );
    return r?.language ?? 'ru';
  }

  private async modelDraft(u: HostUser, title: string, language: string, src: { decisions: { text: string }[]; internalSummary: string; transcript: string }, agreements: string[]) {
    if (!(await this.ai.hasModel(u.tenantId))) return null;
    const prompt = await this.prompts.resolve(u.tenantId, 'meeting.guest_summary', {}, u.userId);
    const input = [
      `Встреча: «${title}»`,
      `Язык ответа: ${language}`,
      src.internalSummary ? `Внутренние краткие итоги:\n${src.internalSummary}` : '',
      src.decisions.length ? `Решения:\n${src.decisions.map((d) => `- ${d.text}`).join('\n')}` : '',
      `Договорённости (в том же порядке):\n${agreements.map((a, i) => `${i + 1}. ${a}`).join('\n') || '(нет)'}`,
      src.transcript ? `Фрагмент стенограммы:\n${src.transcript}` : '',
    ].filter(Boolean).join('\n\n');
    const r = await Promise.race([
      this.ai.generateWithModel(u.tenantId, prompt?.body ?? SYSTEM_FALLBACK, input, 'guest_summary', {
        promptVersionId: prompt?.versionId ?? null, model: prompt?.model, params: prompt?.params,
      }),
      new Promise<null>((res) => setTimeout(() => res(null), MODEL_TIMEOUT_MS).unref?.()),
    ]);
    if (!r) return null;
    const parsed = parseModelDraft(r.text, agreements);
    return parsed ? { ...parsed, model: r.model } : null;
  }

  async save(u: HostUser, meetingId: string, d: {
    language: string; text: string;
    agreements: { text: string; side: string; deadlineAt?: string | null }[];
    nextMeeting?: { title: string; at: string; url?: string | null } | null;
  }) {
    await this.hostMeeting(u, meetingId);
    const s = await this.repo.summaryOf(u.tenantId, meetingId);
    if (!s) throw AppException.notFound('Сначала подготовьте черновик');
    const agreements = d.agreements
      .map((a) => ({ text: String(a.text || '').trim().slice(0, 500), side: (SIDES as string[]).includes(a.side) ? a.side as AgreementSide : 'unassigned', deadlineAt: a.deadlineAt && !Number.isNaN(Date.parse(a.deadlineAt)) ? new Date(a.deadlineAt).toISOString() : null }))
      .filter((a) => a.text)
      .slice(0, 30);
    const next = d.nextMeeting && d.nextMeeting.title && !Number.isNaN(Date.parse(d.nextMeeting.at))
      ? { title: d.nextMeeting.title.slice(0, 255), at: new Date(d.nextMeeting.at), url: d.nextMeeting.url ? String(d.nextMeeting.url).slice(0, 500) : null }
      : null;
    await this.repo.saveDraft(s.id, u.tenantId, { language: guestLanguage(d.language), text: String(d.text || '').trim().slice(0, 3000), next, agreements });
    return this.hostView(u, meetingId);
  }

  /**
   * Опубликовать клиенту (п. 32–33, 62–63, 66): снимок версии, письмо гостям «итоги
   * готовы» (или «обновлены»), запись в ленту клиента. Гость видит ровно этот снимок,
   * даже пока хозяин правит черновик дальше.
   */
  async publish(u: HostUser, meetingId: string) {
    const meeting = await this.hostMeeting(u, meetingId);
    const s = await this.repo.summaryOf(u.tenantId, meetingId);
    if (!s) throw AppException.notFound('Сначала подготовьте черновик');
    const [agreements, files] = await Promise.all([this.repo.agreements(s.id), this.repo.files(s.id)]);
    if (!s.summary_text.trim() && !agreements.length) throw AppException.validation('Протокол пуст — добавьте текст или договорённости');
    const version = s.version + 1;
    const json: PublishedSummary = {
      version,
      language: s.language,
      summary: s.summary_text,
      agreements: agreements.map((a) => ({ text: a.text, side: a.owner_side, deadlineAt: a.deadline_at ? new Date(a.deadline_at).toISOString() : null })),
      files: files.map((f) => f.file_id),
      nextMeeting: s.next_meeting_at ? { title: s.next_meeting_title ?? 'Встреча', at: new Date(s.next_meeting_at).toISOString(), url: s.next_meeting_url } : null,
      publishedAt: new Date().toISOString(),
    };
    await this.repo.publish(s.id, u.userId, json);
    const sent = meeting.room_id ? await this.mailGuests(u, meeting, s, version) : 0;
    if (meeting.client_id) {
      await this.repo.clientActivity(u.tenantId, meeting.client_id, `${version > 1 ? 'Обновлены' : 'Опубликованы'} итоги встречи «${meeting.title}» для клиента`, meeting.id, { version }).catch(() => undefined);
    }
    return { ...(await this.hostView(u, meetingId)), mailed: sent };
  }

  /** Письма гостям: персональная ссылка каждому; вошедшим по общей ссылке — своя, только на итоги. */
  private async mailGuests(u: HostUser, meeting: MeetingRow, s: SummaryRow, version: number): Promise<number> {
    const guests = await this.repo.guests(u.tenantId, meeting.room_id!);
    const event = await this.repo.eventOfRoom(u.tenantId, meeting.room_id!);
    const brand = await this.repo.brand(u.tenantId);
    const company = brand?.company_name || brand?.tenant_name || '';
    const done = new Set<string>();
    let n = 0;
    for (const g of guests) {
      if (!g.email || g.revoked) continue;
      const email = g.email.toLowerCase();
      if (done.has(email)) continue;
      let token: string | null = null;
      if (g.kind === 'invite' && g.token_enc) token = this.crypto.decrypt(g.token_enc);
      if (!token && !guests.some((x) => x.kind === 'invite' && !x.revoked && x.email?.toLowerCase() === email && x.token_enc)) {
        token = randomBytes(24).toString('base64url');
        await this.repo.summaryInvite({
          tenantId: u.tenantId, roomId: meeting.room_id!, eventId: event?.event_id ?? null, createdBy: u.userId,
          tokenHash: sha256(token), tokenEnc: this.crypto.encrypt(token), email, name: g.name,
        });
      }
      if (!token) continue;
      done.add(email);
      const en = s.language === 'en';
      const subject = en
        ? `${version > 1 ? 'Updated meeting notes' : 'Meeting notes'}: ${meeting.title}`
        : `${version > 1 ? 'Итоги встречи обновлены' : 'Итоги встречи готовы'}: ${meeting.title}`;
      const body = (en
        ? [`Hello${g.name ? `, ${g.name}` : ''}!`, '', version > 1 ? `The notes of "${meeting.title}" have been updated.` : `The notes of "${meeting.title}" are ready: agreements and next steps.`, '', `Open: ${this.baseUrl()}/meet/${token}`, '', company ? `— ${company}` : '']
        : [`Здравствуйте${g.name ? `, ${g.name}` : ''}!`, '', version > 1 ? `Итоги встречи «${meeting.title}» обновлены.` : `Итоги встречи «${meeting.title}» готовы: договорённости и следующие шаги.`, '', `Открыть: ${this.baseUrl()}/meet/${token}`, '', company ? `— ${company}` : '']
      ).join('\n');
      await this.db.query(
        `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
         VALUES ($1, NULL, $2, $3, $4, NULL, 'guest.summary', $5) ON CONFLICT (dedup_key) DO NOTHING`,
        [u.tenantId, email, subject.slice(0, 255), body, `guest.summary:${s.id}:${version}:${email}`.slice(0, 160)],
      ).catch((e) => this.log.warn(`письмо с итогами ${email}: ${(e as Error).message}`));
      n++;
    }
    return n;
  }

  async addFile(u: HostUser, meetingId: string, fileId: string) {
    await this.hostMeeting(u, meetingId);
    const s = await this.repo.summaryOf(u.tenantId, meetingId);
    if (!s) throw AppException.notFound('Сначала подготовьте черновик');
    if (!(await this.files.canDownload(u.tenantId, fileId, { userId: u.userId, role: u.role }))) throw AppException.notFound('Файл не найден');
    await this.repo.addFile(u.tenantId, s.id, fileId, u.userId);
    await this.repo.touch(s.id);
    return this.hostView(u, meetingId);
  }

  async removeFile(u: HostUser, meetingId: string, fileId: string) {
    await this.hostMeeting(u, meetingId);
    const s = await this.repo.summaryOf(u.tenantId, meetingId);
    if (!s) throw AppException.notFound('Протокола нет');
    await this.repo.removeFile(s.id, fileId);
    await this.repo.touch(s.id);
    return this.hostView(u, meetingId);
  }

  async handleFeedback(u: HostUser, meetingId: string, id: string) {
    await this.hostMeeting(u, meetingId);
    const s = await this.repo.summaryOf(u.tenantId, meetingId);
    if (s) await this.repo.handleFeedback(s.id, id);
    return this.hostView(u, meetingId);
  }

  async metrics(tenantId: string, days = 30) {
    const m = await this.repo.metrics(tenantId, days);
    const n = (k: string) => Number(m?.[k] ?? 0);
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    return {
      days, opened: n('opened'), joined: n('joined'), published: n('published'), viewed: n('viewed'),
      acknowledged: n('acknowledged'), feedback: n('feedback'), cta: n('cta'),
      ackRate: pct(n('acknowledged'), n('viewed')),
    };
  }
}

function sha256(v: string) {
  return createHash('sha256').update(v).digest('hex');
}
