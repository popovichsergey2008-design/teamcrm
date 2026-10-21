import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { PlatformService } from '../platform/platform.service';
import { PromptsService } from '../prompts/prompts.service';
import { PushService } from '../notifications/push.service';
import { RealtimeService } from '../realtime/realtime.service';
import { SecurityService } from '../security/security.service';
import { SupportDeskRepository } from './support-desk.repository';
import { SupportDeskService } from './support-desk.service';
import { SupportConciergeRepository } from './support-concierge.repository';
import {
  ACCESS_MINUTES, engineerStatus, EngineerStatus, MANUAL_STATUSES, ManualStatus, parseResolution, rulesResolution, STATUS_TEXT, waitEstimate,
} from './support-concierge';

type User = { userId: string; role: string; tenantId?: string };

const TICK_MS = 30_000;
const RESOLUTION_FALLBACK = 'Составь итог обращения: JSON {"problem","fixed","checked","next"} — по одному короткому предложению. Верни только JSON.';

/**
 * Консьерж-поддержка (ТЗ-29) поверх «Службы заботы» (ТЗ-8).
 *
 * Принцип (п. 2): не тикет, а живой человек рядом. Здесь — то, без чего «рядом» не
 * работает: честный статус инженера и время ожидания, обратный звонок, когда все
 * заняты, согласие на запись, итог помощи после созвона и доступ на 15 минут к
 * настройкам проекта — только с разрешения самого пользователя.
 */
@Injectable()
export class SupportConciergeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SupportConcierge');
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly repo: SupportConciergeRepository,
    private readonly deskRepo: SupportDeskRepository,
    private readonly desk: SupportDeskService,
    private readonly platform: PlatformService,
    private readonly realtime: RealtimeService,
    private readonly push: PushService,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly security: SecurityService,
  ) {}

  onModuleInit(): void {
    // итог помощи — после созвона поддержки (п. 25)
    this.desk.onHuddleDone((conversationId, tenantId, summary) => this.buildResolution(tenantId, conversationId, summary));
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => void this.callbackTick().catch(() => undefined), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  // ── доступность (п. 6–8, 31) ──

  /** Инженеры и их честные статусы + оценка ожидания для панели. */
  async availability() {
    const platformTenant = await this.platform.tenantId();
    const staff = platformTenant ? await this.platform.onDuty() : [];
    const ids = staff.map((s) => String(s.user_id));
    const [manual, shifts, huddle, loads, queue, median, avatars] = await Promise.all([
      this.repo.manualStatuses(ids), this.repo.shiftState(ids), this.repo.inHuddle(ids),
      this.deskRepo.loadByAgent(), this.repo.queueSize(), this.deskRepo.medianFirstResponse(null),
      this.repo.avatars(ids),
    ]);
    const online = new Set(platformTenant ? this.realtime.onlineUsers(platformTenant).map(String) : []);
    const manualBy = new Map(manual.map((m) => [m.user_id, m.status]));
    const shiftBy = new Map(shifts.map((s) => [s.user_id, s]));
    const huddleSet = new Set(huddle.map((h) => h.user_id));
    const loadBy = new Map(loads.map((l) => [String(l.agent_id), Number(l.n)]));
    const avatarBy = new Map(avatars.map((a) => [a.id, a]));
    const engineers = staff.map((s) => {
      const id = String(s.user_id);
      const status = engineerStatus({
        online: online.has(id), manual: manualBy.get(id) ?? null, inHuddle: huddleSet.has(id),
        load: loadBy.get(id) ?? 0, maxLoad: Number(s.max_conversations ?? 5),
        hasShifts: !!shiftBy.get(id)?.has_shifts, onShift: !!shiftBy.get(id)?.on_shift,
      });
      const av = avatarBy.get(id);
      return {
        userId: id,
        name: s.full_name,
        role: s.role === 'engineer' ? 'Инженер QEVO' : 'Специалист QEVO',
        verified: true,
        avatarUrl: av?.avatar_file_id ? this.files.signPlay(av.tenant_id, av.avatar_file_id, 3600).url : null,
        status,
        statusText: STATUS_TEXT[status],
      };
    });
    const order: EngineerStatus[] = ['available', 'in_huddle', 'busy', 'away', 'offline'];
    engineers.sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
    const available = engineers.filter((e) => e.status === 'available').length;
    const reachable = engineers.filter((e) => e.status === 'available' || e.status === 'busy' || e.status === 'in_huddle').length;
    return {
      engineers: engineers.slice(0, 6),
      estimate: waitEstimate({ available, online: reachable, queue, medianSec: median }),
      available,
      medianSec: median,
    };
  }

  /** Статусы для маршрутизации: «отошёл» и «вне смены» обращения не получают. */
  async unavailableIds(): Promise<Set<string>> {
    const a = await this.availability();
    return new Set(a.engineers.filter((e) => e.status === 'away' || e.status === 'offline').map((e) => e.userId));
  }

  async setMyStatus(user: User, status: ManualStatus) {
    if (!(MANUAL_STATUSES as readonly string[]).includes(status)) throw AppException.validation('Неизвестный статус');
    if (!(await this.platform.canDesk(user.userId))) throw AppException.forbidden('Статус ставит специалист службы заботы');
    await this.repo.setManual(user.userId, status);
    if (status === 'available') void this.callbackTick().catch(() => undefined);
    await this.broadcastAvailability();
    return this.availability();
  }

  private async broadcastAvailability() {
    const platformTenant = await this.platform.tenantId();
    if (!platformTenant) return;
    for (const s of await this.platform.onDuty()) {
      this.realtime.emitToUsers(platformTenant, [String(s.user_id)], 'support.availability.changed', {});
    }
  }

  // ── смены (п. 10) ──

  private async assertManage(user: User) {
    if (!(await this.platform.canManage(user.userId))) throw AppException.forbidden('Смены настраивает руководитель службы заботы');
  }

  async shifts(user: User) {
    if (!(await this.platform.canDesk(user.userId))) throw AppException.forbidden('Только для службы заботы');
    const t = await this.platform.tenantId();
    if (!t) return [];
    return (await this.repo.shifts(t)).map((s) => ({ id: s.id, userId: s.support_user_id, name: s.full_name, startsAt: s.starts_at, endsAt: s.ends_at }));
  }

  async addShift(user: User, d: { userId: string; startsAt: string; endsAt: string }) {
    await this.assertManage(user);
    const t = await this.platform.tenantId();
    if (!t) throw AppException.conflict('Платформа не назначена');
    const staff = await this.platform.staffAll();
    if (!staff.some((s) => String(s.user_id) === String(d.userId))) throw AppException.validation('Это не сотрудник службы заботы');
    const from = new Date(d.startsAt), to = new Date(d.endsAt);
    if (!(to.getTime() > from.getTime()) || to.getTime() - from.getTime() > 24 * 3_600_000) throw AppException.validation('Смена — от начала до конца, не длиннее суток');
    await this.repo.addShift(t, d.userId, from, to, user.userId);
    return this.shifts(user);
  }

  async cancelShift(user: User, id: string) {
    await this.assertManage(user);
    const t = await this.platform.tenantId();
    if (t) await this.repo.cancelShift(t, id);
    return this.shifts(user);
  }

  // ── обратный звонок (п. 32–33) ──

  async callback(tenantId: string, user: User) {
    const active = await this.deskRepo.activeOf(tenantId, user.userId);
    const r = await this.repo.addCallback(tenantId, user.userId, active ? String(active.id) : null);
    void this.callbackTick().catch(() => undefined);
    return { waiting: true, since: r?.created_at ?? new Date() };
  }

  async cancelCallback(user: User) {
    await this.repo.cancelCallback(user.userId);
    return { waiting: false };
  }

  async callbackState(user: User) {
    const r = await this.repo.pendingCallback(user.userId);
    return { waiting: !!r, since: r?.created_at ?? null };
  }

  /** Освободился инженер — зовём самого давнего ждущего (по одному на свободного). */
  async callbackTick(): Promise<void> {
    const a = await this.availability();
    for (let i = 0; i < a.available; i++) {
      const cb = await this.repo.claimCallback();
      if (!cb) return;
      const path = cb.conversation_id ? `/support/${cb.conversation_id}` : '/support';
      this.realtime.emitToUsers(cb.tenant_id, [cb.user_id], 'support.callback.ready', { conversationId: cb.conversation_id });
      await this.push.personal({
        tenantId: cb.tenant_id, userId: cb.user_id, eventKey: 'support.callback',
        title: 'Инженер готов подключиться', body: 'Откройте службу заботы — можно сразу созвониться', path,
      }).catch(() => false);
      const platformTenant = await this.platform.tenantId();
      if (platformTenant) {
        for (const e of a.engineers.filter((x) => x.status === 'available')) {
          this.realtime.emitToUsers(platformTenant, [e.userId], 'support.callback.ready', { conversationId: cb.conversation_id });
        }
      }
    }
  }

  // ── запись (п. 29) ──

  async recordingConsent(tenantId: string, user: User, id: string, allow: boolean) {
    const conv = await this.ownConversation(tenantId, user, id);
    await this.repo.setRecordingConsent(id, allow);
    await this.deskRepo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: allow ? 'разрешил(а) записать созвон — итог вернётся сюда' : 'созвон без записи',
    });
    this.emitConv(tenantId, conv, 'support.recording.consent', { conversationId: id, allow });
    return this.desk.conversation(tenantId, user, id);
  }

  // ── итог помощи (п. 25–26) ──

  async buildResolution(tenantId: string, conversationId: string, summary: string | null): Promise<void> {
    try {
      const conv = await this.deskRepo.byId(tenantId, conversationId);
      if (!conv) return;
      let res = rulesResolution(conv.subject ?? 'Обращение', summary);
      if (await this.ai.hasModel(tenantId).catch(() => false)) {
        const messages = (await this.deskRepo.messages(conversationId))
          .filter((m) => m.author_kind !== 'system').slice(-16)
          .map((m) => `${m.author_kind === 'user' ? 'Пользователь' : 'Поддержка'}: ${String(m.body ?? '').slice(0, 400)}`).join('\n');
        const prompt = await this.prompts.resolve(tenantId, 'support.resolution', {}, conversationId);
        const out = await this.ai.generate(tenantId, prompt?.body ?? RESOLUTION_FALLBACK,
          `Тема: ${conv.subject}\n\nПереписка:\n${messages}\n\nИтоги созвона:\n${summary ?? '(нет)'}`, 'support_resolution', {
            promptVersionId: prompt?.versionId ?? null, model: prompt?.model, params: prompt?.params,
          }).catch(() => '');
        res = parseResolution(out) ?? res;
      }
      await this.repo.setResolution(conversationId, res);
      await this.deskRepo.addMessage({ tenantId, conversationId, authorId: null, kind: 'system', body: 'Итог помощи готов — проверьте, всё ли работает.' });
      this.emitConv(tenantId, conv, 'support.request.resolution', { conversationId });
    } catch (e) {
      this.log.warn(`итог помощи ${conversationId}: ${(e as Error).message}`);
    }
  }

  /** «Всё работает» / «Проблема осталась» на карточке итога. */
  async resolutionFeedback(tenantId: string, user: User, id: string, works: boolean) {
    const conv = await this.ownConversation(tenantId, user, id);
    await this.repo.setResolutionFeedback(id, works ? 'works' : 'not_fixed');
    await this.deskRepo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: works ? 'подтвердил(а): всё работает' : 'проблема осталась — продолжаем',
    });
    this.emitConv(tenantId, conv, works ? 'support.request.resolved' : 'support.request.reopened', { conversationId: id });
    if (!works) await this.desk.reopen(tenantId, user, id, 'Проблема осталась').catch(() => undefined);
    return this.desk.conversation(tenantId, user, id);
  }

  async offerTest(tenantId: string, user: User, id: string) {
    const conv = await this.staffConversation(tenantId, user, id);
    await this.repo.offerTest(id);
    await this.deskRepo.addMessage({ tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'предлагает проверить ИИ-протокол за 10 секунд' });
    this.emitConv(tenantId, conv, 'support.test.offered', { conversationId: id });
    return this.desk.conversation(tenantId, user, id);
  }

  // ── доступ на 15 минут (п. 45) ──

  async requestAccess(tenantId: string, user: User, id: string, reason: string | null) {
    const conv = await this.staffConversation(tenantId, user, id);
    await this.repo.requestAccess(tenantId, id, user.userId, reason?.trim().slice(0, 300) || null);
    await this.deskRepo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: `просит разрешения посмотреть настройки проекта на ${ACCESS_MINUTES} минут${reason ? `: ${reason.trim().slice(0, 200)}` : ''}`,
    });
    this.emitConv(tenantId, conv, 'support.access.requested', { conversationId: id });
    return this.accessList(tenantId, user, id);
  }

  async accessList(tenantId: string, user: User, id: string) {
    await this.anyConversation(tenantId, user, id);
    const now = Date.now();
    return (await this.repo.grantsOf(id)).map((g) => ({
      id: g.id, engineer: g.support_name, projectId: g.resource_id, projectName: g.project_name, reason: g.reason,
      status: g.status === 'granted' && g.expires_at && new Date(g.expires_at).getTime() <= now ? 'expired' : g.status,
      requestedAt: g.requested_at, expiresAt: g.expires_at,
    }));
  }

  /** Разрешает только сам обратившийся и только проект, который он сам видит. */
  async decideAccess(tenantId: string, user: User, id: string, grantId: string, d: { allow: boolean; projectId?: string }) {
    const conv = await this.ownConversation(tenantId, user, id);
    const g = await this.repo.grant(id, grantId);
    if (!g || g.status !== 'requested') throw AppException.conflict('Эта просьба уже неактуальна');
    if (d.allow) {
      if (!d.projectId || !(await this.repo.projectVisibleTo(tenantId, user.userId, user.role, d.projectId))) {
        throw AppException.validation('Выберите проект, который вы сами можете открыть');
      }
      await this.repo.decideGrant(grantId, { status: 'granted', by: user.userId, projectId: d.projectId, minutes: ACCESS_MINUTES });
      await this.security.record({
        tenantId, actorId: user.userId, event: 'support.access.granted', resourceType: 'project', resourceId: d.projectId,
        targetUserId: g.support_user_id, metadata: { conversationId: id, minutes: ACCESS_MINUTES },
      }).catch(() => undefined);
    } else {
      await this.repo.decideGrant(grantId, { status: 'declined', by: user.userId });
    }
    await this.deskRepo.addMessage({
      tenantId, conversationId: id, authorId: user.userId, kind: 'system',
      body: d.allow ? `разрешил(а) смотреть настройки проекта ${ACCESS_MINUTES} минут` : 'не разрешил(а) доступ к настройкам',
    });
    this.emitConv(tenantId, conv, 'support.access.changed', { conversationId: id });
    return this.accessList(tenantId, user, id);
  }

  async revokeAccess(tenantId: string, user: User, id: string, grantId: string) {
    const conv = await this.ownConversation(tenantId, user, id);
    const g = await this.repo.grant(id, grantId);
    if (!g || g.status !== 'granted') throw AppException.conflict('Доступ уже закрыт');
    await this.repo.decideGrant(grantId, { status: 'revoked', by: user.userId });
    await this.security.record({ tenantId, actorId: user.userId, event: 'support.access.revoked', resourceType: 'project', resourceId: g.resource_id, targetUserId: g.support_user_id, metadata: { conversationId: id } }).catch(() => undefined);
    await this.deskRepo.addMessage({ tenantId, conversationId: id, authorId: user.userId, kind: 'system', body: 'закрыл(а) доступ к настройкам проекта' });
    this.emitConv(tenantId, conv, 'support.access.changed', { conversationId: id });
    return this.accessList(tenantId, user, id);
  }

  /** Настройки проекта глазами инженера — только по живому разрешению и только своему. */
  async accessView(tenantId: string, user: User, id: string, grantId: string) {
    await this.staffConversation(tenantId, user, id);
    const g = await this.repo.grant(id, grantId);
    if (!g || g.status !== 'granted' || String(g.support_user_id) !== String(user.userId) || !g.resource_id
      || !g.expires_at || new Date(g.expires_at).getTime() <= Date.now()) {
      throw AppException.forbidden('Доступа нет или он истёк — попросите разрешение ещё раз');
    }
    await this.repo.markViewed(grantId);
    await this.security.record({ tenantId, actorId: user.userId, event: 'support.access.viewed', resourceType: 'project', resourceId: g.resource_id, metadata: { conversationId: id } }).catch(() => undefined);
    const snap = await this.repo.projectSnapshot(tenantId, g.resource_id);
    return { ...snap, expiresAt: g.expires_at };
  }

  /**
   * Чей созвон (ТЗ-29): окну созвона нужно знать, что это поддержка, — тогда перед
   * показом экрана оно говорит, что инженер ничем не управляет, а запись спрашивает
   * разрешения. Чужой комнате — «не поддержка», без подробностей.
   */
  async room(user: User & { tenantId: string }, roomId: string) {
    const h = await this.repo.huddleOfRoom(String(roomId).slice(0, 64));
    if (!h) return { support: false as const };
    const mine = h.user_id === String(user.userId) && h.tenant_id === String(user.tenantId);
    const staff = !mine && (await this.platform.canDesk(user.userId));
    if (!mine && !staff) return { support: false as const };
    return { support: true as const, conversationId: h.conversation_id, requester: mine, recordingConsent: h.recording_consent };
  }

  // ── метрики (п. 49) ──

  async metrics(user: User) {
    if (!(await this.platform.canDesk(user.userId))) throw AppException.forbidden('Только для службы заботы');
    const m = await this.repo.metrics();
    const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : null);
    return {
      huddleOffered: m?.offered ?? 0,
      huddleAcceptRate: pct(m?.accepted ?? 0, m?.offered ?? 0),
      resolved: m?.resolved ?? 0,
      firstContactResolution: pct(m?.fcr ?? 0, m?.resolved ?? 0),
    };
  }

  // ── общее ──

  private async ownConversation(tenantId: string, user: User, id: string) {
    const conv = await this.deskRepo.byId(tenantId, id);
    if (!conv || String(conv.user_id) !== String(user.userId)) throw AppException.notFound('Разговор не найден');
    return conv;
  }

  private async staffConversation(tenantId: string, user: User, id: string) {
    const conv = await this.deskRepo.byId(tenantId, id);
    if (!conv || !(await this.desk.canWorkOn(tenantId, user, id))) throw AppException.notFound('Разговор не найден');
    return conv;
  }

  private async anyConversation(tenantId: string, user: User, id: string) {
    const conv = await this.deskRepo.byId(tenantId, id);
    if (!conv) throw AppException.notFound('Разговор не найден');
    if (String(conv.user_id) !== String(user.userId) && !(await this.desk.canWorkOn(tenantId, user, id))) throw AppException.notFound('Разговор не найден');
    return conv;
  }

  private emitConv(tenantId: string, conv: { user_id: string | number; assigned_agent_id?: string | number | null }, event: string, payload: Record<string, unknown>) {
    this.realtime.emitToUsers(tenantId, [String(conv.user_id)], event, payload);
    if (conv.assigned_agent_id) {
      void this.platform.tenantId().then((home) => this.realtime.emitToUsers(home ?? tenantId, [String(conv.assigned_agent_id)], event, payload));
    }
  }
}
