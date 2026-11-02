import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { PlatformService } from '../platform/platform.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AiSettingsService } from '../ai/ai-settings.service';
import { AiGuardService } from '../ai/ai-guard.service';
import { effective, SubRow } from '../billing/billing-rules';
import { PcAuth } from './pc.guard';
import { aiState, SUB_TEXT } from './pc-support-rules';

/** Так служба заботы видит оператора: обычный «пользователь» организации-платформы. */
export interface Operator { userId: string; tenantId: string; role: 'member'; email: string }

/**
 * Консоль поддержки на support.qevo.one (§6; решение заказчика 02.11 — своя учётка).
 *
 * Оператор входит учёткой консоли, а служба заботы работает со служебным профилем
 * (users.is_service, 0223): неактивный, без входа в CRM, ни в одном чате. Профиль
 * заводится при первом входе в консоль, имя берётся из учётки консоли. Право работать
 * с обращениями — по-прежнему platform_staff: снятая роль поддержки снимает и его.
 */
@Injectable()
export class PcSupportService {
  private readonly cache = new Map<string, { at: number; op: Operator }>();

  constructor(
    private readonly db: DbService,
    private readonly platform: PlatformService,
    private readonly realtime: RealtimeService,
    private readonly ai: AiSettingsService,
    private readonly guard: AiGuardService,
  ) {}

  async operator(pc: PcAuth): Promise<Operator> {
    const hit = this.cache.get(pc.accountId);
    if (hit && Date.now() - hit.at < 60_000) return hit.op;
    const tenantId = await this.platform.tenantId();
    if (!tenantId) throw AppException.conflict('Организация-платформа не настроена — консоли поддержки не к кому подключиться');
    const userId = await this.db.withTransaction(async (c) => {
      // строка учётки под замком: два первых запроса подряд не заведут два профиля
      const acc = (await c.query<{ crm_user_id: string | null }>(
        `SELECT crm_user_id::text FROM pc_accounts WHERE id=$1 FOR UPDATE`, [pc.accountId])).rows[0];
      if (!acc) throw AppException.unauthorized('Учётная запись не найдена');
      let id = acc.crm_user_id;
      if (id) {
        await c.query(`UPDATE users SET full_name=$2 WHERE id=$1 AND full_name <> $2`, [id, pc.name.slice(0, 160)]);
      } else {
        id = (await c.query<{ id: string }>(
          `INSERT INTO users (tenant_id, email, password_hash, full_name, role_id, is_active, is_service, can_receive_auto_tasks)
           SELECT $1, $2, '!service-no-login', $3, r.id, false, true, false FROM roles r WHERE r.code='member'
           RETURNING id::text`,
          [tenantId, `support-${pc.accountId}@console.qevo.one`, pc.name.slice(0, 160)],
        )).rows[0].id;
        await c.query(`UPDATE pc_accounts SET crm_user_id=$2 WHERE id=$1`, [pc.accountId, id]);
      }
      // первая линия; владелец платформы с ролью поддержки — руководитель службы
      // (известные проблемы, массовый сбой). Снять с дежурства можно, профиль остаётся.
      const role = pc.roles.includes('owner') ? 'support_admin' : 'support';
      await c.query(
        `INSERT INTO platform_staff (user_id, tenant_id, role, active) VALUES ($1, $2, $3, true)
         ON CONFLICT (user_id) DO UPDATE SET role = EXCLUDED.role`, [id, tenantId, role]);
      return id;
    });
    const op: Operator = { userId, tenantId, role: 'member', email: pc.email };
    this.cache.set(pc.accountId, { at: Date.now(), op });
    return op;
  }

  /** Владелец снял роль поддержки или заблокировал — служба заботы перестаёт слать ему обращения. */
  async syncStaff(accountId: string, support: boolean): Promise<void> {
    this.cache.delete(accountId);
    const row = await this.db.one<{ crm_user_id: string | null }>(`SELECT crm_user_id::text FROM pc_accounts WHERE id=$1`, [accountId]);
    if (!row?.crm_user_id) return;
    await this.db.query(`UPDATE platform_staff SET active=$2 WHERE user_id=$1`, [row.crm_user_id, support]);
    if (!support) {
      const tenantId = await this.platform.tenantId();
      if (tenantId) this.realtime.presenceGone(tenantId, row.crm_user_id);
    }
  }

  /** «Я на месте»: консоль шлёт раз в 30 с, пока вкладка открыта. */
  beat(op: Operator, away: boolean): void {
    if (away) this.realtime.presenceGone(op.tenantId, op.userId);
    else this.realtime.presenceBeat(op.tenantId, op.userId);
  }

  /**
   * Карточка клиента (§6): компания, тариф, ИИ с причиной отказа. Без ключей и цен —
   * их оператор не видит (§7).
   */
  async client(conversationTenantId: string) {
    const [t, keys, guard] = await Promise.all([
      this.db.one<SubRow & { name: string; created_at: Date; is_platform: boolean; is_test: boolean; has_row: boolean; members: number; plan_title: string | null }>(
        `SELECT t.name, t.created_at, t.is_platform, t.is_test, s.tenant_id IS NOT NULL AS has_row,
                s.status, s.plan_code, s.trial_ends_at, s.current_period_end, coalesce(s.complimentary, false) AS complimentary,
                (SELECT count(*)::int FROM users u WHERE u.tenant_id=t.id AND u.is_active) AS members,
                (SELECT title FROM billing_plans bp WHERE bp.code = s.plan_code) AS plan_title
           FROM tenants t LEFT JOIN tenant_subscriptions s ON s.tenant_id=t.id WHERE t.id=$1`, [conversationTenantId]),
      this.ai.keysOf(conversationTenantId),
      this.guard.decision().catch(() => ({ any: true, shared: true, reason: null })),
    ]);
    if (!t) return null;
    const sub = effective(t.has_row ? t : null, new Date(t.created_at), new Date(), t.is_platform);
    const trial = keys.global && !keys.own ? await this.ai.trial(conversationTenantId).catch(() => null) : null;
    return {
      company: t.name,
      isTest: t.is_test,
      members: t.members,
      plan: t.plan_title ?? t.plan_code ?? null,
      subscription: { status: sub.status, text: sub.complimentary ? 'Бесплатно (без срока)' : SUB_TEXT[sub.status] ?? sub.status, until: sub.until },
      ai: aiState({ own: keys.own, guard: { any: guard.any, shared: guard.shared, reason: guard.reason ?? null }, trial }),
    };
  }
}
