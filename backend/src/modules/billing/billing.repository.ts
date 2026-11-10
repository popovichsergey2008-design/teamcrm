import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { PriceMove, SubRow } from './billing-rules';

export interface PlanRow {
  code: string; title: string; price_rub: string; price_year_rub: string | null; max_members: number | null;
  description: string; sort_order: number; is_active: boolean; version: number;
}

export interface TenantSubRow extends SubRow {
  tenant_id: string;
  tenant_name: string;
  tenant_created_at: Date;
  is_platform: boolean;
  payment_method_id: string | null;
  autopay: boolean;
  notified: Record<string, unknown>;
  /** За что платили: период продления и цена (не меняются вместе с прайсом). */
  period_months: number;
  price_rub: string | null;
  plan_version: number | null;
  /** Тестовая компания — её может продлить тестовый платёж (только в sub()). */
  is_test?: boolean;
  /** #4779: пробный 7 + 7 — начало и начисленный бонус за Telegram-бота (только в sub()). */
  trial_started_at?: Date | null;
  trial_bonus_days?: number;
}

export interface PaymentRow {
  id: string; tenant_id: string; provider_payment_id: string | null; plan_code: string; amount_rub: string;
  status: string; kind: string; created_at: Date; paid_at: Date | null; period_end: Date | null; cancel_reason: string | null;
  period_months: number; plan_version: number | null; is_test: boolean;
}

@Injectable()
export class BillingRepository {
  constructor(private readonly db: DbService) {}

  plans(activeOnly = true): Promise<PlanRow[]> {
    return this.db.many<PlanRow>(
      `SELECT code, title, price_rub::text, price_year_rub::text, max_members, description, sort_order, is_active, version
         FROM billing_plans ${activeOnly ? 'WHERE is_active' : ''} ORDER BY sort_order, price_rub`,
    );
  }

  plan(code: string): Promise<PlanRow | null> {
    return this.db.one<PlanRow>(`SELECT code, title, price_rub::text, price_year_rub::text, max_members, description, sort_order, is_active, version FROM billing_plans WHERE code=$1`, [code]);
  }

  /**
   * Сохранить тариф. Поменялось что-то денежное или лимит — новая версия (§5.4): история
   * цен остаётся, а действующие подписки продлеваются по своей цене, не по новой.
   */
  async upsertPlan(p: {
    code: string; title: string; priceRub: number; priceYearRub?: number | null; maxMembers: number | null;
    description: string; sortOrder: number; isActive: boolean; changedBy?: string | null;
  }) {
    await this.db.withTransaction(async (c) => {
      const cur = await c.query<{ title: string; price_rub: string; price_year_rub: string | null; max_members: number | null; description: string; is_active: boolean; version: number }>(
        `SELECT title, price_rub::text, price_year_rub::text, max_members, description, is_active, version FROM billing_plans WHERE code=$1 FOR UPDATE`, [p.code]);
      const old = cur.rows[0];
      // не передали годовую цену (старая ручка консоли поддержки) — оставляем прежнюю
      const year = p.priceYearRub === undefined ? (old?.price_year_rub == null ? null : Number(old.price_year_rub)) : p.priceYearRub;
      const changed = !old || Number(old.price_rub) !== p.priceRub || (old.price_year_rub == null ? null : Number(old.price_year_rub)) !== year
        || old.max_members !== p.maxMembers || old.title !== p.title || old.description !== p.description || old.is_active !== p.isActive;
      const version = old ? old.version + (changed ? 1 : 0) : 1;
      await c.query(
        `INSERT INTO billing_plans (code, title, price_rub, price_year_rub, max_members, description, sort_order, is_active, version, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())
         ON CONFLICT (code) DO UPDATE SET title=$2, price_rub=$3, price_year_rub=$4, max_members=$5, description=$6, sort_order=$7,
           is_active=$8, version=$9, updated_at=now()`,
        [p.code, p.title, p.priceRub, year, p.maxMembers, p.description, p.sortOrder, p.isActive, version]);
      if (changed) {
        await c.query(
          `INSERT INTO billing_plan_versions (plan_code, version, title, price_month_rub, price_year_rub, max_members, description, is_active, changed_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (plan_code, version) DO NOTHING`,
          [p.code, version, p.title, p.priceRub, year, p.maxMembers, p.description, p.isActive, p.changedBy ?? null]);
      }
    });
  }

  /** Подписка вместе с тем, что нужно правилам: когда создана компания, площадка ли это. */
  sub(tenantId: string): Promise<TenantSubRow | null> {
    return this.db.one<TenantSubRow>(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.created_at AS tenant_created_at, t.is_platform,
              COALESCE(s.status, 'TRIAL') AS status, s.plan_code, COALESCE(s.trial_ends_at, t.trial_ends_at) AS trial_ends_at, s.current_period_end,
              COALESCE(s.complimentary, FALSE) AS complimentary, s.payment_method_id,
              COALESCE(s.autopay, FALSE) AS autopay, COALESCE(s.notified, '{}'::jsonb) AS notified,
              COALESCE(s.period_months, 1) AS period_months, s.price_rub::text, s.plan_version, t.is_test,
              t.trial_started_at, COALESCE(t.trial_bonus_days, 0) AS trial_bonus_days
         FROM tenants t LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
        WHERE t.id = $1`,
      [tenantId],
    );
  }

  /** Подписки, по которым может быть что сказать или продлить (без «вечных» и площадки). */
  watchList(): Promise<TenantSubRow[]> {
    return this.db.many<TenantSubRow>(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.created_at AS tenant_created_at, t.is_platform,
              COALESCE(s.status, 'TRIAL') AS status, s.plan_code, COALESCE(s.trial_ends_at, t.trial_ends_at) AS trial_ends_at, s.current_period_end,
              COALESCE(s.complimentary, FALSE) AS complimentary, s.payment_method_id,
              COALESCE(s.autopay, FALSE) AS autopay, COALESCE(s.notified, '{}'::jsonb) AS notified,
              COALESCE(s.period_months, 1) AS period_months, s.price_rub::text, s.plan_version
         FROM tenants t LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
        WHERE NOT t.is_platform AND NOT COALESCE(s.complimentary, FALSE)
          AND (s.current_period_end IS NULL OR s.current_period_end < now() + interval '4 days')
          AND t.created_at > now() - interval '400 days'`,
    );
  }

  async markNotified(tenantId: string, key: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, notified) VALUES ($1, jsonb_build_object($2::text, now()))
       ON CONFLICT (tenant_id) DO UPDATE SET notified = tenant_subscriptions.notified || jsonb_build_object($2::text, now())`,
      [tenantId, key],
    );
  }

  async setStatus(tenantId: string, status: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, status) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET status = $2, updated_at = now() WHERE tenant_subscriptions.status <> $2`,
      [tenantId, status],
    );
  }

  async setAutopay(tenantId: string, on: boolean): Promise<void> {
    await this.db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, autopay) VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET autopay = $2, updated_at = now()`,
      [tenantId, on],
    );
  }

  /** Вендор: «вечный» доступ или продление вручную. */
  async setByVendor(tenantId: string, p: { complimentary?: boolean; periodEnd?: Date | null; planCode?: string | null; trialEndsAt?: Date | null }) {
    await this.db.query(
      `INSERT INTO tenant_subscriptions (tenant_id, complimentary, current_period_end, plan_code, trial_ends_at, status)
       VALUES ($1, COALESCE($2::boolean, FALSE), $3::timestamptz, $4, $5::timestamptz, 'ACTIVE')
       ON CONFLICT (tenant_id) DO UPDATE SET
         complimentary = COALESCE($2::boolean, tenant_subscriptions.complimentary),
         current_period_end = CASE WHEN $6::boolean THEN $3::timestamptz ELSE tenant_subscriptions.current_period_end END,
         plan_code = COALESCE($4, tenant_subscriptions.plan_code),
         trial_ends_at = CASE WHEN $7::boolean THEN $5::timestamptz ELSE tenant_subscriptions.trial_ends_at END,
         updated_at = now()`,
      [tenantId, p.complimentary ?? null, p.periodEnd ?? null, p.planCode ?? null, p.trialEndsAt ?? null,
        p.periodEnd !== undefined, p.trialEndsAt !== undefined],
    );
  }

  async createPayment(p: {
    tenantId: string; planCode: string; amountRub: string; kind: 'checkout' | 'autopay'; createdBy: string | null;
    periodMonths?: number; planVersion?: number | null;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO billing_payments (tenant_id, plan_code, amount_rub, kind, created_by, period_months, plan_version)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id::text`,
      [p.tenantId, p.planCode, p.amountRub, p.kind, p.createdBy, p.periodMonths ?? 1, p.planVersion ?? null],
    );
    return row!.id;
  }

  async attachProviderId(id: string, providerId: string): Promise<void> {
    await this.db.query(`UPDATE billing_payments SET provider_payment_id=$2 WHERE id=$1`, [id, providerId]);
  }

  paymentByProvider(providerId: string): Promise<PaymentRow | null> {
    return this.db.one<PaymentRow>(
      `SELECT id::text, tenant_id::text, provider_payment_id, plan_code, amount_rub::text, status, kind, created_at, paid_at, period_end, cancel_reason,
              period_months, plan_version, is_test
         FROM billing_payments WHERE provider_payment_id=$1`,
      [providerId],
    );
  }

  payments(tenantId: string, limit = 24): Promise<PaymentRow[]> {
    return this.db.many<PaymentRow>(
      `SELECT id::text, tenant_id::text, provider_payment_id, plan_code, amount_rub::text, status, kind, created_at, paid_at, period_end, cancel_reason,
              period_months, plan_version, is_test
         FROM billing_payments WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`,
      [tenantId, limit],
    );
  }

  /** Успешный платёж: отметить и продлить подписку — одной транзакцией и ровно один раз. */
  async applySucceeded(p: {
    paymentId: string; tenantId: string; planCode: string; periodEnd: Date; paymentMethodId: string | null;
    isTest?: boolean;
  }): Promise<boolean> {
    return this.db.withTransaction(async (c) => {
      // цена, период и версия — из самого платежа: подписка продлевается так, как за неё заплатили
      const upd = await c.query<{ amount_rub: string; period_months: number; plan_version: number | null }>(
        `UPDATE billing_payments SET status='succeeded', paid_at=now(), period_end=$2, is_test=$3::boolean
          WHERE id=$1 AND status='pending' RETURNING amount_rub::text, period_months, plan_version`,
        [p.paymentId, p.periodEnd.toISOString(), !!p.isTest],
      );
      if (!upd.rowCount) return false; // уже учтён (повтор уведомления)
      const paid = upd.rows[0];
      await c.query(
        `INSERT INTO tenant_subscriptions (tenant_id, status, plan_code, current_period_end, payment_method_id, autopay, notified,
                                           period_months, price_rub, plan_version)
         VALUES ($1, 'ACTIVE', $2, $3, $4::text, $4::text IS NOT NULL, '{}'::jsonb, $5::int, $6::numeric, $7::int)
         ON CONFLICT (tenant_id) DO UPDATE SET status='ACTIVE', plan_code=$2, current_period_end=$3,
           payment_method_id = COALESCE($4::text, tenant_subscriptions.payment_method_id),
           autopay = CASE WHEN $4::text IS NOT NULL THEN TRUE ELSE tenant_subscriptions.autopay END,
           period_months=$5::int, price_rub=$6::numeric, plan_version=$7::int,
           notified='{}'::jsonb, updated_at=now()`,
        [p.tenantId, p.planCode, p.periodEnd.toISOString(), p.paymentMethodId, paid.period_months, paid.amount_rub, paid.plan_version],
      );
      return true;
    });
  }

  /** Тестовый платёж (магазин в тестовом режиме) у настоящей компании: не продлеваем, отмечаем. */
  async markTestIgnored(paymentId: string): Promise<void> {
    await this.db.query(
      `UPDATE billing_payments SET status='canceled', is_test=true, cancel_reason='тестовый платёж: настоящую подписку не продлевает'
        WHERE id=$1 AND status='pending'`, [paymentId]);
  }

  /** Версии тарифа — что и когда меняли. */
  // ── перевод действующих подписок на новую цену (0225) ──
  /** Оплаченные подписки на этих тарифах — кому может прийти письмо о новой цене. */
  paidOn(planCodes: string[]): Promise<TenantSubRow[]> {
    return this.db.many<TenantSubRow>(
      `SELECT t.id::text AS tenant_id, t.name AS tenant_name, t.created_at AS tenant_created_at, t.is_platform,
              s.status, s.plan_code, s.trial_ends_at, s.current_period_end, coalesce(s.complimentary, false) AS complimentary,
              s.payment_method_id, coalesce(s.autopay, false) AS autopay, coalesce(s.notified, '{}'::jsonb) AS notified,
              coalesce(s.period_months, 1) AS period_months, s.price_rub::text, s.plan_version
         FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.plan_code = ANY($1::text[]) AND s.current_period_end > now()
          AND NOT t.is_platform AND NOT coalesce(s.complimentary, false)`, [planCodes]);
  }

  activeMoves(): Promise<PriceMove[]> {
    return this.db.many<PriceMove>(
      `SELECT id::text, plan_code, to_version, price_month_rub::text, price_year_rub::text, to_char(apply_from, 'YYYY-MM-DD') AS apply_from
         FROM billing_price_moves WHERE cancelled_at IS NULL`);
  }

  /** Переводы тарифа и сколько оплаченных подписок они касаются (без вечных и площадки). */
  moves(code: string) {
    return this.db.many<{ id: string; to_version: number; price_month_rub: string; price_year_rub: string | null; apply_from: string;
      note: string | null; created_at: Date; cancelled_at: Date | null; by_email: string | null; affected: number; notified: number }>(
      `SELECT m.id::text, m.to_version, m.price_month_rub::text, m.price_year_rub::text, to_char(m.apply_from, 'YYYY-MM-DD') AS apply_from,
              m.note, m.created_at, m.cancelled_at, a.email AS by_email,
              (SELECT count(*)::int FROM tenant_subscriptions s JOIN tenants t ON t.id = s.tenant_id
                WHERE s.plan_code = m.plan_code AND s.current_period_end IS NOT NULL AND NOT coalesce(s.complimentary, false)
                  AND NOT t.is_platform AND (s.plan_version IS NULL OR s.plan_version < m.to_version)) AS affected,
              (SELECT count(*)::int FROM tenant_subscriptions s WHERE s.notified ? ('price_move:' || m.id)) AS notified
         FROM billing_price_moves m LEFT JOIN pc_accounts a ON a.id = m.created_by
        WHERE m.plan_code = $1 ORDER BY m.id DESC LIMIT 50`, [code]);
  }

  async createMove(m: { planCode: string; toVersion: number; priceMonth: string; priceYear: string | null; applyFrom: string; note: string | null; by: string }) {
    const r = await this.db.one<{ id: string }>(
      `INSERT INTO billing_price_moves (plan_code, to_version, price_month_rub, price_year_rub, apply_from, note, created_by)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7) RETURNING id::text`,
      [m.planCode, m.toVersion, m.priceMonth, m.priceYear, m.applyFrom, m.note, m.by]);
    return r!.id;
  }

  async cancelMove(id: string, by: string): Promise<boolean> {
    const r = await this.db.query(`UPDATE billing_price_moves SET cancelled_at = now(), cancelled_by = $2 WHERE id = $1 AND cancelled_at IS NULL`, [id, by]);
    return (r.rowCount ?? 0) > 0;
  }

  planVersions(code: string) {
    return this.db.many<{ version: number; title: string; price_month_rub: string; price_year_rub: string | null; max_members: number | null; is_active: boolean; changed_by: string | null; created_at: Date }>(
      `SELECT version, title, price_month_rub::text, price_year_rub::text, max_members, is_active, changed_by, created_at
         FROM billing_plan_versions WHERE plan_code=$1 ORDER BY version DESC LIMIT 50`, [code]);
  }

  async markCanceled(paymentId: string, reason: string | null): Promise<void> {
    await this.db.query(`UPDATE billing_payments SET status='canceled', cancel_reason=$2 WHERE id=$1 AND status='pending'`, [paymentId, reason]);
  }

  /** Уведомление записано впервые — true; уже было — false (повтор). */
  async recordWebhook(eventId: string, event: string, payload: unknown): Promise<string | null> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO billing_webhook_events (provider_event_id, event, payload) VALUES ($1,$2,$3::jsonb)
       ON CONFLICT (provider_event_id) DO NOTHING RETURNING id::text`,
      [eventId.slice(0, 160), event.slice(0, 64), JSON.stringify(payload ?? {})],
    );
    return row?.id ?? null;
  }

  async webhookDone(id: string, error: string | null): Promise<void> {
    await this.db.query(`UPDATE billing_webhook_events SET processed_at=now(), error=$2 WHERE id=$1`, [id, error]);
  }

  // ── «Пригласить команду · +1 мес» ──

  /**
   * Сколько человек пришло в команду, не считая владельца: участники как в membersCount
   * (без клиентов, служебный профиль поддержки не активен и не считается) минус один.
   */
  async invitedCount(tenantId: string): Promise<number> {
    return Math.max(0, (await this.membersCount(tenantId)) - 1);
  }

  /** Отметка бонуса за команду: когда начислен и до какого числа продлил. */
  teamBonusOf(tenantId: string) {
    return this.db.one<{ team_bonus_at: Date | null; team_bonus_until: Date | null }>(
      `SELECT team_bonus_at, team_bonus_until FROM tenants WHERE id = $1`, [tenantId],
    );
  }

  /** Пространства, уже набравшие команду, но без бонуса: «вечные» и площадка не в счёт. */
  async teamBonusCandidates(minInvited: number): Promise<string[]> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT t.id::text FROM tenants t
         LEFT JOIN tenant_subscriptions s ON s.tenant_id = t.id
        WHERE t.team_bonus_at IS NULL AND NOT t.is_platform AND NOT COALESCE(s.complimentary, FALSE)
          AND (SELECT count(*) FROM users u JOIN roles r ON r.id = u.role_id
                WHERE u.tenant_id = t.id AND u.is_active AND r.code <> 'client') - 1 >= $1`,
      [minInvited],
    );
    return rows.map((r) => r.id);
  }

  /**
   * Начислить месяц за команду — один раз. Продлевается то, что сейчас действует:
   * оплаченный срок, иначе пробный (свой у подписки или у пространства). Уже кончилось —
   * месяц считается от сегодня. Отметка и продление — одной транзакцией.
   * Начислили — новый конец; уже было (или «вечное») — null.
   */
  async grantTeamBonus(tenantId: string, months: number, trialDays: number): Promise<Date | null> {
    return this.db.withTransaction(async (c) => {
      const mark = await c.query(
        `UPDATE tenants t SET team_bonus_at = now(), updated_at = now()
          WHERE t.id = $1 AND t.team_bonus_at IS NULL AND NOT t.is_platform
            AND NOT EXISTS (SELECT 1 FROM tenant_subscriptions s WHERE s.tenant_id = t.id AND s.complimentary)
          RETURNING t.id`, [tenantId],
      );
      if (!mark.rowCount) return null;
      const step = `make_interval(months => ${Number(months)})`;
      const sub = await c.query<{ current_period_end: Date | null; trial_ends_at: Date | null }>(
        `SELECT current_period_end, trial_ends_at FROM tenant_subscriptions WHERE tenant_id = $1 FOR UPDATE`, [tenantId],
      );
      const s = sub.rows[0];
      let until: Date;
      if (s?.current_period_end) {
        until = (await c.query<{ v: Date }>(
          `UPDATE tenant_subscriptions SET current_period_end = GREATEST(current_period_end, now()) + ${step}, updated_at = now()
            WHERE tenant_id = $1 RETURNING current_period_end AS v`, [tenantId])).rows[0].v;
      } else if (s?.trial_ends_at) {
        until = (await c.query<{ v: Date }>(
          `UPDATE tenant_subscriptions SET trial_ends_at = GREATEST(trial_ends_at, now()) + ${step}, updated_at = now()
            WHERE tenant_id = $1 RETURNING trial_ends_at AS v`, [tenantId])).rows[0].v;
      } else {
        until = (await c.query<{ v: Date }>(
          `UPDATE tenants SET trial_ends_at = GREATEST(COALESCE(trial_ends_at, created_at + make_interval(days => $2::int)), now()) + ${step}
            WHERE id = $1 RETURNING trial_ends_at AS v`, [tenantId, trialDays])).rows[0].v;
      }
      await c.query(`UPDATE tenants SET team_bonus_until = $2 WHERE id = $1`, [tenantId, until]);
      return until;
    });
  }

  async membersCount(tenantId: string): Promise<number> {
    const r = await this.db.one<{ n: string }>(
      `SELECT count(*)::text AS n FROM users u JOIN roles r ON r.id=u.role_id WHERE u.tenant_id=$1 AND u.is_active AND r.code <> 'client'`,
      [tenantId],
    );
    return Number(r?.n ?? 0);
  }

  owners(tenantId: string): Promise<{ id: string; email: string; full_name: string }[]> {
    return this.db.many(
      `SELECT u.id::text, u.email, u.full_name FROM users u JOIN roles r ON r.id=u.role_id
        WHERE u.tenant_id=$1 AND u.is_active AND r.code='owner'`,
      [tenantId],
    );
  }

  async enqueueMail(i: { tenantId: string; userId: string; to: string; subject: string; text: string; html: string; eventKey: string; dedupKey: string }) {
    await this.db.query(
      `INSERT INTO mail_outbox (tenant_id, user_id, to_email, subject, body_text, body_html, event_key, dedup_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (dedup_key) DO NOTHING`,
      [i.tenantId, i.userId, i.to, i.subject.slice(0, 255), i.text, i.html, i.eventKey, i.dedupKey.slice(0, 160)],
    );
  }
}
