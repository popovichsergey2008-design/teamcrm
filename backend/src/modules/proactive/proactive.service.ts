import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { InboxRepository } from '../notifications/inbox.repository';
import { PushService } from '../notifications/push.service';
import { TelegramMirror } from '../notifications/telegram-mirror.service';
import { SecurityService } from '../security/security.service';
import { can } from '../security/permissions';
import { localParts } from '../assistant/ping-rules';
import { zonedTime } from '../focus/close-day';
import { NewProposal, ProposalRow, ProactiveRepository } from './proactive.repository';
import {
  batchLine, compareRank, deliveryFor, FEEDBACK_REASONS, PRIORITY_LABEL, rankKey, SECTION_OF, Skill, SKILLS, snoozeTarget, SnoozePreset,
} from './proactive-rules';

export interface Actor { tenantId: string; userId: string; role: string }

/** Что умеет навык: выполнить кнопку карточки. Пишут в базу только сервисы продукта (§91). */
export interface ProposalHandler {
  skill: Skill;
  execute(actor: Actor, p: ProposalRow, action: string, params: Record<string, unknown>): Promise<{
    text: string;
    link?: string | null;
    /** Карточка остаётся открытой (например, «Напомнить» — ждём выполнения обещания). */
    keepOpen?: boolean;
  }>;
}

/**
 * Ящик предложений проактивного секретаря (ТЗ-21, этап 1).
 *
 * Навыки (обещания, нагрузка, ответы, письмо клиенту, утренний бриф) не шлют уведомления
 * сами и не пишут в базу напрямую: они кладут предложение сюда, а ящик решает, как
 * сообщить (тишина, лимит, приоритет), и по нажатию передаёт его обработчику навыка.
 */
@Injectable()
export class ProactiveService {
  private readonly log = new Logger('Proactive');
  private readonly handlers = new Map<string, ProposalHandler>();

  constructor(
    private readonly repo: ProactiveRepository,
    private readonly realtime: RealtimeService,
    private readonly inbox: InboxRepository,
    private readonly push: PushService,
    private readonly telegram: TelegramMirror,
    private readonly security: SecurityService,
  ) {}

  register(h: ProposalHandler): void {
    this.handlers.set(h.skill, h);
  }

  // ───────────────────────── создание ─────────────────────────

  /**
   * Предложить. Возвращает созданное или null: навык выключен (компанией или человеком),
   * «больше не предлагать такое», уже было с тем же отпечатком.
   */
  async propose(p: NewProposal): Promise<ProposalRow | null> {
    try {
      const [tenant, prefs] = await Promise.all([this.repo.tenantSettings(p.tenantId), this.repo.prefs(p.tenantId, p.userId)]);
      if (!tenant.enabled || prefs.level === 'off') return null;
      const skillOn: Record<string, boolean> = {
        commitment: tenant.commitments, workload: tenant.workloadGuard, reply: tenant.smartReply && prefs.smartReply,
        followup: tenant.clientFollowup, brief: tenant.morningAudio, decision: true,
      };
      if (skillOn[p.skill] === false) return null;
      if (await this.repo.muted(p.tenantId, p.userId, p.skill, p.kind ?? '')) return null;
      const row = await this.repo.insert(p);
      if (!row) return null;
      await this.deliver(row, prefs);
      return row;
    } catch (e) {
      this.log.warn(`предложение ${p.skill} для ${p.userId}: ${(e as Error).message}`);
      return null;
    }
  }

  /** Сообщить человеку по правилам тишины и лимита (§9, §83–84). */
  private async deliver(row: ProposalRow, prefs: { level: string; dailyLimit: number }) {
    const tz = await this.repo.timezoneOf(row.tenant_id, row.user_id);
    const dayStart = zonedTime(localParts(new Date(), tz).date, '00:00', tz);
    const [quiet, sentToday] = await Promise.all([
      this.inbox.isQuiet(row.tenant_id, row.user_id).catch(() => false),
      this.repo.notifiedSince(row.tenant_id, row.user_id, dayStart),
    ]);
    const how = deliveryFor({ priority: row.priority, quiet, level: prefs.level, sentToday, dailyLimit: prefs.dailyLimit });
    // в открытом приложении карточка появляется сразу — это не уведомление, а обновление ящика
    this.realtime.emitToUsers(row.tenant_id, [row.user_id], 'assistant.proposal', { id: String(row.id), kind: 'created', delivery: how });
    if (how === 'silent') return;
    await this.repo.markNotified(String(row.id));
    await this.push.personal({
      tenantId: row.tenant_id, userId: row.user_id, eventKey: 'assistant.proposal',
      title: `${PRIORITY_LABEL[row.priority]} · ${row.title}`.slice(0, 120),
      body: (row.summary || row.why).slice(0, 200), path: `/secretary/${row.id}`, push: how === 'push',
    }).catch(() => false);
    if (how === 'push') {
      const tenant = await this.repo.tenantSettings(row.tenant_id);
      if (tenant.telegramDelivery) await this.telegram.push(row.tenant_id, row.user_id, `✦ ${row.title}\n\n${row.summary || row.why}`.slice(0, 900)).catch(() => false);
    }
  }

  /** Источник решён без нас (задача закрыта, ответ ушёл) — открытая карточка закрывается сама. */
  async resolveBySource(tenantId: string, skill: Skill, sourceType: string, sourceId: string, text: string) {
    const users = await this.repo.resolveBySource(tenantId, skill, sourceType, sourceId, text);
    if (users.length) this.realtime.emitToUsers(tenantId, users, 'assistant.proposal', { kind: 'updated' });
  }

  // ───────────────────────── ящик ─────────────────────────

  async list(a: Actor, o: { section?: string; history?: boolean } = {}) {
    const rows = o.history ? await this.repo.history(a.tenantId, a.userId) : await this.repo.open(a.tenantId, a.userId, true);
    const items = rows
      .map((r) => this.view(r))
      .filter((v) => o.history || !o.section || v.section === o.section);
    if (!o.history) {
      items.sort((x, y) => compareRank(
        rankKey({ priority: x.priority, dueAt: (x.payload.dueAt as string) ?? null, confidence: x.confidence, createdAt: x.createdAt }),
        rankKey({ priority: y.priority, dueAt: (y.payload.dueAt as string) ?? null, confidence: y.confidence, createdAt: y.createdAt }),
      ));
      // снятые с отложенного — в конец открытых
      items.sort((x, y) => Number(x.status === 'snoozed') - Number(y.status === 'snoozed'));
    }
    return { items };
  }

  /** Сводка для значка и шапки: сколько и где, + «ещё ждут решения» в других разделах. */
  async summary(a: Actor) {
    const [counts, elsewhere] = await Promise.all([
      this.repo.counts(a.tenantId, a.userId),
      this.repo.elsewhere(a.tenantId, a.userId, a.role === 'owner' || a.role === 'manager'),
    ]);
    const bySection: Record<string, number> = {};
    const bySkill: Partial<Record<Skill, number>> = {};
    let total = 0;
    let urgent = 0;
    for (const c of counts) {
      const sec = SECTION_OF[c.skill as Skill] ?? 'attention';
      bySection[sec] = (bySection[sec] ?? 0) + c.n;
      bySkill[c.skill as Skill] = (bySkill[c.skill as Skill] ?? 0) + c.n;
      total += c.n;
      if (c.priority <= 1) urgent += c.n;
    }
    return { total, urgent, bySection, line: batchLine(bySkill), elsewhere };
  }

  async get(a: Actor, id: string) {
    const r = await this.repo.get(a.tenantId, a.userId, String(id));
    if (!r) throw AppException.notFound('Предложение не найдено');
    return this.view(r);
  }

  async seen(a: Actor, ids: string[]) {
    await this.repo.markSeen(a.tenantId, a.userId, ids.map(String).slice(0, 200));
    return { ok: true };
  }

  /**
   * Нажали кнопку карточки. Захват атомарный (двойное нажатие не выполнит дважды);
   * сбой — карточка возвращается открытой с текстом ошибки, а не пропадает.
   */
  async act(a: Actor, id: string, action: string, params: Record<string, unknown> = {}) {
    const row = await this.repo.get(a.tenantId, a.userId, String(id));
    if (!row) throw AppException.notFound('Предложение не найдено');
    const def = row.actions.find((x) => x.key === action);
    if (!def) throw AppException.validation('Такого действия у карточки нет');
    const handler = this.handlers.get(row.skill);
    if (!handler) throw AppException.conflict('Этот навык сейчас недоступен');
    const claimed = await this.repo.claim(a.tenantId, a.userId, String(id));
    if (!claimed) throw AppException.conflict('Это предложение уже решено');
    try {
      const r = await handler.execute(a, claimed, action, params);
      await this.repo.finish(String(id), r.keepOpen ? 'new' : 'executed', action, r.text);
      void this.security.record({
        tenantId: a.tenantId, actorId: a.userId, event: 'secretary.proposal.executed', resourceType: 'assistant_proposal',
        resourceId: String(id), metadata: { skill: row.skill, action, risk: def.risk ?? null },
      }).catch(() => undefined);
      this.realtime.emitToUsers(a.tenantId, [a.userId], 'assistant.proposal', { id: String(id), kind: 'updated' });
      return { ok: true, text: r.text, link: r.link ?? null, proposal: await this.get(a, String(id)) };
    } catch (e) {
      const msg = e instanceof AppException ? e.message : 'Не получилось выполнить';
      await this.repo.finish(String(id), 'new', null, null, msg);
      throw e instanceof AppException ? e : AppException.conflict(msg);
    }
  }

  async dismiss(a: Actor, id: string, o: { mute?: boolean; reason?: string } = {}) {
    const row = await this.repo.get(a.tenantId, a.userId, String(id));
    if (!row) throw AppException.notFound('Предложение не найдено');
    await this.repo.dismiss(a.tenantId, a.userId, String(id));
    if (o.reason) await this.feedback(a, String(id), false, o.reason);
    // «больше не предлагать такое» — вид навыка (обещания в этом чате), а не весь навык
    if (o.mute) await this.repo.mute(a.tenantId, a.userId, row.skill, row.kind);
    this.realtime.emitToUsers(a.tenantId, [a.userId], 'assistant.proposal', { id: String(id), kind: 'updated' });
    return { dismissed: true, muted: !!o.mute };
  }

  async snooze(a: Actor, id: string, preset: SnoozePreset) {
    const tz = await this.repo.timezoneOf(a.tenantId, a.userId);
    const l = localParts(new Date(), tz);
    const t = snoozeTarget(preset, { date: l.date, hour: l.hour, minute: l.minute, isoDow: l.dow === 0 ? 7 : l.dow });
    const until = t.kind === 'relative' ? new Date(Date.now() + t.minutes * 60_000) : zonedTime(t.date, t.time, tz);
    if (!(await this.repo.snooze(a.tenantId, a.userId, String(id), until))) throw AppException.conflict('Это предложение уже решено');
    this.realtime.emitToUsers(a.tenantId, [a.userId], 'assistant.proposal', { id: String(id), kind: 'updated' });
    return { snoozedUntil: until };
  }

  async feedback(a: Actor, id: string, useful: boolean, reason?: string | null) {
    const r = reason && (FEEDBACK_REASONS as readonly string[]).includes(reason) ? reason : null;
    if (!(await this.repo.get(a.tenantId, a.userId, String(id)))) throw AppException.notFound('Предложение не найдено');
    await this.repo.feedback(a.tenantId, a.userId, String(id), useful, r);
    return { ok: true };
  }

  // ───────────────────────── настройки ─────────────────────────

  async prefs(a: Actor) {
    const [prefs, mutes] = await Promise.all([this.repo.prefs(a.tenantId, a.userId), this.repo.mutes(a.tenantId, a.userId)]);
    return { ...prefs, mutes: mutes.map((m) => ({ skill: m.skill, kind: m.kind })) };
  }

  async savePrefs(a: Actor, p: { level?: string; dailyLimit?: number; smartReply?: boolean; morningAudio?: boolean }) {
    const level = p.level && ['normal', 'quiet', 'off'].includes(p.level) ? p.level : undefined;
    const dailyLimit = p.dailyLimit != null ? Math.max(1, Math.min(50, Math.round(p.dailyLimit))) : undefined;
    await this.repo.savePrefs(a.tenantId, a.userId, { level, dailyLimit, smartReply: p.smartReply, morningAudio: p.morningAudio });
    return this.prefs(a);
  }

  async unmute(a: Actor, skill: string, kind: string) {
    await this.repo.unmute(a.tenantId, a.userId, skill, kind ?? '');
    return this.prefs(a);
  }

  /** Навыки компании (§89) — владельцу и тем, кто управляет ИИ. */
  async tenantSettings(a: Actor) {
    await this.needManage(a);
    return this.repo.tenantSettings(a.tenantId);
  }

  async saveTenantSettings(a: Actor, s: Record<string, unknown>) {
    await this.needManage(a);
    const allowed = ['enabled', 'commitments', 'workloadGuard', 'smartReply', 'clientFollowup', 'morningAudio', 'secondBrain',
      'externalSend', 'telegramDelivery', 'commitmentCheckHours', 'commitmentEscalateHours', 'commitmentMinConfidence', 'aiDailyLimits'];
    const patch = Object.fromEntries(Object.entries(s).filter(([k]) => allowed.includes(k)));
    await this.repo.saveTenantSettings(a.tenantId, patch);
    void this.security.record({ tenantId: a.tenantId, actorId: a.userId, event: 'secretary.settings.changed', metadata: patch }).catch(() => undefined);
    return this.repo.tenantSettings(a.tenantId);
  }

  /** Качество навыков (§110): доля выполненных, отклонённых, «бесполезно». */
  async quality(a: Actor, days = 30) {
    await this.needManage(a);
    const [rows, x] = await Promise.all([this.repo.quality(a.tenantId, days), this.repo.extraQuality(a.tenantId, days)]);
    const pct = (n: number, d: number) => (d ? Math.round((n / d) * 100) : null);
    const extra = x ? {
      replies: { total: x.replies, acceptedPct: pct(x.accepted, x.replies), editedPct: pct(x.edited, x.replies), dismissedPct: pct(x.dismissed, x.replies) },
      commitments: { total: x.commitments, fulfilledPct: pct(x.fulfilled, x.commitments), untrackedPct: pct(x.untracked, x.commitments), remindedPct: pct(x.reminded, x.commitments) },
    } : null;
    const skills = rows.map((r) => ({
      skill: r.skill, total: r.total, executed: r.executed, dismissed: r.dismissed, expired: r.expired,
      acceptRate: r.total ? Math.round((r.executed / r.total) * 100) : 0,
      falsePositiveRate: r.useful + r.useless ? Math.round((r.useless / (r.useful + r.useless)) * 100) : null,
    }));
    return { skills, extra };
  }

  private async needManage(a: Actor) {
    const perms = await this.security.permissionsOf(a.tenantId, a.userId);
    if (!can(perms, 'ai.manage')) throw AppException.forbidden('Навыки секретаря настраивает владелец');
  }

  // ───────────────────────── планировщик ─────────────────────────

  /** Раз в несколько минут: отложенное вернуть, неактуальное закрыть. */
  async sweep(): Promise<void> {
    const woke = await this.repo.wakeSnoozed();
    for (const r of woke) this.realtime.emitToUsers(r.tenant_id, [r.user_id], 'assistant.proposal', { id: String(r.id), kind: 'created', delivery: 'badge' });
    await this.repo.expire();
  }

  // ───────────────────────── вид ─────────────────────────

  private view(r: ProposalRow) {
    return {
      id: String(r.id),
      skill: r.skill as Skill,
      kind: r.kind,
      section: SECTION_OF[r.skill as Skill] ?? 'attention',
      title: r.title,
      summary: r.summary,
      why: r.why,
      recommend: r.recommend,
      effect: r.effect,
      priority: r.priority,
      priorityLabel: PRIORITY_LABEL[r.priority] ?? '',
      confidence: Number(r.confidence),
      status: r.status,
      source: { type: r.source_type, id: r.source_id, at: r.source_at, label: r.source_label, link: r.source_link },
      actions: r.actions,
      payload: r.payload ?? {},
      snoozeUntil: r.snooze_until,
      createdAt: r.created_at,
      resolvedAt: r.resolved_at,
      resolvedAction: r.resolved_action,
      result: r.result_text,
      error: r.error,
    };
  }

  static readonly SKILLS = SKILLS;
}
