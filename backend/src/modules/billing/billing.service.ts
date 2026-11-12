import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/http/app-exception';
import { amountValue, effective, Effective, extendPeriod, moveFor, moveKey, movePrice, moveReady, noticeDue, PriceMove, TEAM_BONUS_INVITES, TEAM_BONUS_MONTHS, TRIAL_DAYS } from './billing-rules';
import { BillingRepository, PlanRow, TenantSubRow } from './billing.repository';
import { billingLetter, priceMoveLetter } from './billing-letters';
import { ProviderPayment, YooKassaClient, YooKassaError } from './yookassa.client';

import { runsBackground } from '../../common/process-role';
/** Сколько живёт решение «можно ли писать» для компании: на каждый запрос в базу не ходим. */
const STATE_TTL_MS = 30_000;
const TICK_MS = 10 * 60_000;

/**
 * Подписка компании и оплата через ЮKassa (мастер-план релиза, этап 4).
 *
 * Источник истины об оплате — сама ЮKassa: уведомлению верим только после того, как
 * спросили платёж по его id (уведомления ЮKassa не подписаны). Повторное уведомление
 * и повторная проверка не продлят подписку дважды — платёж учитывается один раз.
 */
@Injectable()
export class BillingService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('Billing');
  private readonly kassa: YooKassaClient | null;
  private readonly autopayAllowed: boolean;
  private readonly cache = new Map<string, { at: number; eff: Effective }>();
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  constructor(private readonly repo: BillingRepository, private readonly config: ConfigService) {
    const shop = String(config.get('YOOKASSA_SHOP_ID') ?? '').trim();
    const key = String(config.get('YOOKASSA_SECRET_KEY') ?? '').trim();
    this.kassa = shop && key ? new YooKassaClient(shop, key) : null;
    // автоплатежи магазину включает ЮKassa по заявке — до этого карту не сохраняем
    this.autopayAllowed = String(config.get('YOOKASSA_AUTOPAY') ?? 'off') === 'on';
  }

  onModuleInit(): void {
    if (!runsBackground()) return; // фоновая работа — только в главном процессе (common/process-role)
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.tick(); }, TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private base(): string {
    return String(this.config.get('APP_BASE_URL') ?? 'https://app.qevo.one').replace(/\/+$/, '');
  }

  // ───────────── состояние ─────────────

  async state(tenantId: string, fresh = false): Promise<Effective> {
    const hit = this.cache.get(tenantId);
    if (!fresh && hit && Date.now() - hit.at < STATE_TTL_MS) return hit.eff;
    const row = await this.repo.sub(tenantId);
    const eff = row ? effective(row, new Date(row.tenant_created_at), new Date(), row.is_platform)
      : { status: 'ACTIVE' as const, until: null, writable: true, complimentary: true };
    this.cache.set(tenantId, { at: Date.now(), eff });
    if (this.cache.size > 5000) this.cache.clear();
    return eff;
  }

  private forget(tenantId: string) {
    this.cache.delete(tenantId);
  }

  /** Экран «Тариф и оплата». */
  async view(tenantId: string) {
    // пригласили шестого и сразу открыли «Тариф» — не ждать фонового прохода
    await this.checkTeamBonus(tenantId).catch(() => undefined);
    const [row, plans, payments, members] = await Promise.all([
      this.repo.sub(tenantId), this.repo.plans(), this.repo.payments(tenantId), this.repo.membersCount(tenantId),
    ]);
    const eff = await this.state(tenantId, true);
    const plan = row?.plan_code ? plans.find((p) => p.code === row.plan_code) ?? null : null;
    // ближайшее продление пойдёт по новой цене — сказать на экране, не только письмом
    const move = row && eff.status === 'ACTIVE' && !eff.complimentary && eff.until
      ? moveFor(row, eff.until, await this.repo.activeMoves()) : null;
    const months = row?.period_months || 1;
    return {
      priceChange: move && eff.until ? {
        at: eff.until, price: movePrice(move, months),
        // письмо ещё не ушло за 14 дней — это продление пройдёт по прежней цене, новая — со следующего
        nextPeriod: !moveReady(row?.notified?.[moveKey(move.id)], eff.until),
      } : null,
      status: eff.status,
      until: eff.until,
      writable: eff.writable,
      complimentary: eff.complimentary,
      plan: plan ? this.planOut(plan) : null,
      period: (row?.period_months ?? 1) === 12 ? 'year' as const : 'month' as const,
      lockedPrice: row?.price_rub != null ? Number(row.price_rub) : null,
      autopay: !!row?.autopay && !!row?.payment_method_id,
      autopayAvailable: this.autopayAllowed,
      members,
      plans: plans.map((p) => this.planOut(p)),
      payments: payments.map((p) => ({
        id: p.id, plan: p.plan_code, amount: Number(p.amount_rub), status: p.status, kind: p.kind, months: p.period_months, test: p.is_test,
        createdAt: p.created_at, paidAt: p.paid_at, periodEnd: p.period_end,
      })),
      configured: !!this.kassa,
      testMode: this.kassa?.testMode ?? false,
      trial: this.trialOut(row, eff),
      teamBonus: eff.complimentary ? null : await this.teamBonusOut(tenantId),
    };
  }

  // ───────────── «Пригласить команду · +1 мес» ─────────────

  private async teamBonusOut(tenantId: string) {
    const [invited, mark] = await Promise.all([this.repo.invitedCount(tenantId), this.repo.teamBonusOf(tenantId)]);
    return {
      need: TEAM_BONUS_INVITES, months: TEAM_BONUS_MONTHS, invited,
      grantedAt: mark?.team_bonus_at ?? null, until: mark?.team_bonus_until ?? null,
    };
  }

  /** Набрали команду — начислить месяц и написать владельцам. Повторно ничего не делает. */
  async checkTeamBonus(tenantId: string): Promise<boolean> {
    if ((await this.repo.invitedCount(tenantId)) < TEAM_BONUS_INVITES) return false;
    const until = await this.repo.grantTeamBonus(tenantId, TEAM_BONUS_MONTHS, TRIAL_DAYS);
    if (!until) return false;
    this.forget(tenantId);
    this.log.log(`бонус за команду: пространство ${tenantId}, до ${until.toISOString().slice(0, 10)}`);
    await this.notify(tenantId, 'team_bonus', until, `team_bonus:${tenantId}`).catch(() => undefined);
    return true;
  }

  /**
   * Пробный период (#4778): 14 дней сразу, бонуса «+7 за Telegram-бота» больше нет.
   * Только для пространств по новой схеме (есть начало пробного).
   */
  private trialOut(row: TenantSubRow | null, eff: Effective) {
    if (eff.status !== 'TRIAL' || !row?.trial_started_at) return null;
    return { baseDays: TRIAL_DAYS, until: eff.until };
  }

  private planOut(p: PlanRow) {
    return {
      code: p.code, title: p.title, price: Number(p.price_rub), priceYear: p.price_year_rub == null ? null : Number(p.price_year_rub),
      maxMembers: p.max_members, description: p.description, perMember: !!p.per_member,
    };
  }

  // ───────────── оплата ─────────────

  /** Начать оплату: платёж в ЮKassa и ссылка на её страницу. Только владелец (проверяет контроллер). */
  async checkout(tenantId: string, userId: string, planCode: string, period: 'month' | 'year' = 'month'): Promise<{ confirmationUrl: string; paymentId: string }> {
    if (!this.kassa) throw AppException.validation('Оплата ещё не подключена — напишите в поддержку');
    const plan = await this.repo.plan(planCode);
    if (!plan || !plan.is_active) throw AppException.validation('Такого тарифа нет');
    if (period === 'year' && plan.price_year_rub == null) throw AppException.validation(`Тариф «${plan.title}» на год не продаётся`);
    const months = period === 'year' ? 12 : 1;
    const members = await this.repo.membersCount(tenantId);
    // ТЗ 10.11: тариф «QEVO» — цена за пользователя, сумма = цена × сотрудники (не меньше одного)
    const unit = Number(period === 'year' ? plan.price_year_rub! : plan.price_rub);
    const price = String(plan.per_member ? unit * Math.max(1, members) : unit);
    if (plan.max_members !== null && members > plan.max_members) {
      throw AppException.validation(`В компании ${members} сотрудников, а тариф «${plan.title}» — до ${plan.max_members}. Выберите тариф побольше`);
    }
    const sub = await this.repo.sub(tenantId);
    const id = await this.repo.createPayment({ tenantId, planCode, amountRub: price, kind: 'checkout', createdBy: userId, periodMonths: months, planVersion: plan.version });
    let pay: ProviderPayment;
    try {
      pay = await this.kassa.createRedirect({
        amount: amountValue(price),
        description: `QEVO, тариф «${plan.title}», ${months === 12 ? '1 год' : '1 месяц'} — ${sub?.tenant_name ?? 'компания'}`,
        returnUrl: `${this.base()}/settings/billing?paid=${id}`,
        metadata: { tenant_id: tenantId, plan: planCode, payment: id, months: String(months) },
        savePaymentMethod: this.autopayAllowed,
        idempotenceKey: `qevo-pay-${id}`,
      });
    } catch (e) {
      await this.repo.markCanceled(id, (e as Error).message);
      this.log.warn(`оплата не создана: ${(e as Error).message}`);
      throw AppException.validation(e instanceof YooKassaError ? `ЮKassa: ${e.message}` : 'ЮKassa не ответила, попробуйте через минуту');
    }
    await this.repo.attachProviderId(id, pay.id);
    const url = pay.confirmation?.confirmation_url;
    if (!url) throw AppException.validation('ЮKassa не вернула страницу оплаты');
    return { confirmationUrl: url, paymentId: id };
  }

  /**
   * Уведомление ЮKassa. Содержимому не верим: берём id и спрашиваем платёж у ЮKassa.
   * Возвращает, что сделали — для журнала и тестов.
   */
  async webhook(body: { event?: string; object?: { id?: string } }): Promise<string> {
    const event = String(body?.event ?? '');
    const providerId = String(body?.object?.id ?? '');
    if (!event || !providerId) return 'ignored';
    const rec = await this.repo.recordWebhook(`${event}:${providerId}`, event, body);
    if (!rec) return 'duplicate';
    try {
      const result = await this.sync(providerId);
      await this.repo.webhookDone(rec, null);
      return result;
    } catch (e) {
      await this.repo.webhookDone(rec, (e as Error).message.slice(0, 500));
      throw e;
    }
  }

  /** Сверить платёж с ЮKassa и применить его исход (общий путь уведомления и возврата со страницы оплаты). */
  async sync(providerId: string): Promise<string> {
    if (!this.kassa) return 'not_configured';
    const local = await this.repo.paymentByProvider(providerId);
    if (!local) return 'unknown_payment';
    const pay = await this.kassa.get(providerId);
    if (pay.status === 'succeeded' && pay.paid) {
      const sub = await this.repo.sub(local.tenant_id);
      // Тестовый магазин ЮKassa продлевает только тестовые компании (§12): проверка
      // оплаты на проде не должна дарить настоящей компании оплаченный месяц.
      if (pay.test && !sub?.is_test) {
        await this.repo.markTestIgnored(local.id);
        this.log.warn(`тестовый платёж ${providerId} у настоящей компании ${local.tenant_id} — подписку не продлеваем`);
        return 'test_ignored';
      }
      const periodEnd = extendPeriod(sub?.current_period_end ? new Date(sub.current_period_end) : null, new Date(), local.period_months || 1);
      const saved = pay.payment_method?.saved ? pay.payment_method.id : null;
      const applied = await this.repo.applySucceeded({
        paymentId: local.id, tenantId: local.tenant_id, planCode: local.plan_code, periodEnd, paymentMethodId: saved, isTest: !!pay.test,
      });
      this.forget(local.tenant_id);
      if (applied) {
        this.log.log(`оплата ${providerId}: компания ${local.tenant_id}, до ${periodEnd.toISOString().slice(0, 10)}`);
        await this.notify(local.tenant_id, 'paid', periodEnd, `paid:${local.id}`);
      }
      return applied ? 'succeeded' : 'already';
    }
    if (pay.status === 'canceled') {
      await this.repo.markCanceled(local.id, pay.cancellation_details?.reason ?? null);
      if (local.kind === 'autopay') await this.notify(local.tenant_id, 'autopay_failed', null, `autopay_failed:${local.id}`);
      return 'canceled';
    }
    return pay.status;
  }

  /** Человек вернулся со страницы оплаты — не ждём уведомления, сверяем сразу. */
  async afterReturn(tenantId: string, localPaymentId: string): Promise<{ status: string }> {
    const rows = await this.repo.payments(tenantId, 50);
    const p = rows.find((r) => r.id === String(localPaymentId));
    if (!p?.provider_payment_id) throw AppException.notFound('Платёж не найден');
    if (p.status !== 'pending') return { status: p.status };
    return { status: await this.sync(p.provider_payment_id) };
  }

  async setAutopay(tenantId: string, on: boolean) {
    await this.repo.setAutopay(tenantId, on);
    return this.view(tenantId);
  }

  /** Добавить человека можно? Пробный и «вечный» — без ограничения, оплаченный — по тарифу. */
  async assertSeat(tenantId: string, adding = 1): Promise<void> {
    const eff = await this.state(tenantId);
    if (eff.complimentary || eff.status === 'TRIAL') return;
    const row = await this.repo.sub(tenantId);
    const plan = row?.plan_code ? await this.repo.plan(row.plan_code) : null;
    if (!plan || plan.max_members === null) return;
    const members = await this.repo.membersCount(tenantId);
    if (members + adding > plan.max_members) {
      throw AppException.validation(`Тариф «${plan.title}» — до ${plan.max_members} сотрудников, сейчас ${members}. Смените тариф в «Настройки → Тариф и оплата»`);
    }
  }

  // ───────────── фоновая проверка сроков ─────────────

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try { await this.sweep(new Date()); } catch (e) { this.log.warn(`проход: ${(e as Error).message}`); } finally { this.busy = false; }
  }

  /** Сказать владельцам о сроках, продлить автоплатежом, записать статусы. `now` — для тестов. */
  async sweep(now: Date): Promise<number> {
    let acted = 0;
    const moves = await this.repo.activeMoves();
    // Перевод на новую цену касается ближайшего продления — письмо один раз на перевод,
    // сразу, а не за 4 дня: новую цену списываем, только если письмо ушло за 14 дней.
    if (moves.length) {
      for (const row of await this.repo.paidOn([...new Set(moves.map((m) => m.plan_code))])) {
        const eff = effective(row, new Date(row.tenant_created_at), now, row.is_platform);
        const move = eff.status === 'ACTIVE' && !eff.complimentary && eff.until ? moveFor(row, eff.until, moves) : null;
        if (!move || !eff.until || row.notified?.[moveKey(move.id)]) continue;
        await this.notifyMove(row, move, eff.until);
        await this.repo.markNotified(row.tenant_id, moveKey(move.id));
        acted += 1;
      }
    }
    // «+1 мес за команду»: тем, кто набрал 6 приглашённых с прошлого прохода
    for (const id of await this.repo.teamBonusCandidates(TEAM_BONUS_INVITES)) {
      if (await this.checkTeamBonus(id).catch((e) => { this.log.warn(`бонус за команду ${id}: ${(e as Error).message}`); return false; })) acted += 1;
    }
    for (const row of await this.repo.watchList()) {
      const eff = effective(row, new Date(row.tenant_created_at), now, row.is_platform);
      const stored = eff.status === 'GRACE' ? 'PAST_DUE' : eff.status;
      if (row.status !== stored) await this.repo.setStatus(row.tenant_id, stored);
      if (eff.status === 'ACTIVE' && row.autopay && row.payment_method_id && eff.until
        && eff.until.getTime() - now.getTime() < 86_400_000) {
        await this.renew(row, eff.until, moves).catch((e) => this.log.warn(`автопродление ${row.tenant_id}: ${(e as Error).message}`));
      }
      // ключ периода: новый оплаченный период — уведомления о нём заново
      const periodKey = new Date(row.current_period_end ?? row.trial_ends_at ?? row.tenant_created_at).toISOString().slice(0, 10);
      const due = noticeDue(eff, row.notified ?? {}, now, periodKey);
      if (due) {
        await this.notify(row.tenant_id, due.split(':')[0], eff.until, due);
        await this.repo.markNotified(row.tenant_id, due);
        acted += 1;
      }
      this.forget(row.tenant_id);
    }
    return acted;
  }

  private async renew(row: TenantSubRow, periodEnd: Date, moves: PriceMove[]): Promise<void> {
    if (!this.kassa || !row.plan_code || !row.payment_method_id) return;
    const plan = await this.repo.plan(row.plan_code);
    if (!plan) return;
    // Продление — по цене и периоду, за которые платили (§5.4): новый прайс действующую
    // подписку молча не меняет. Перевод на новую цену — решением владельца платформы
    // (0225), и только если письмо о нём ушло не позже чем за 14 дней до списания.
    const months = row.period_months || 1;
    const move = moveFor(row, periodEnd, moves);
    const moved = move && moveReady(row.notified?.[moveKey(move.id)], periodEnd) ? move : null;
    const price = moved ? amountValue(movePrice(moved, months)) : row.price_rub ?? (months === 12 ? plan.price_year_rub ?? plan.price_rub : plan.price_rub);
    const key = `qevo-renew-${row.tenant_id}-${periodEnd.toISOString().slice(0, 10)}`;
    const id = await this.repo.createPayment({
      tenantId: row.tenant_id, planCode: plan.code, amountRub: price, kind: 'autopay', createdBy: null,
      periodMonths: months, planVersion: moved ? moved.to_version : row.plan_version,
    });
    const pay = await this.kassa.createRecurring({
      amount: amountValue(price), paymentMethodId: row.payment_method_id,
      description: `QEVO, тариф «${plan.title}», продление на ${months === 12 ? '1 год' : '1 месяц'}`,
      metadata: { tenant_id: row.tenant_id, plan: plan.code, payment: id }, idempotenceKey: key,
    });
    await this.repo.attachProviderId(id, pay.id);
    await this.sync(pay.id);
  }

  /** Письмо владельцам о переводе на новую цену. */
  private async notifyMove(row: TenantSubRow, move: PriceMove, at: Date): Promise<void> {
    const plan = await this.repo.plan(move.plan_code);
    const months = row.period_months || 1;
    const letter = priceMoveLetter({
      planTitle: plan?.title ?? move.plan_code, oldPrice: row.price_rub != null ? Number(row.price_rub) : null,
      newPrice: movePrice(move, months), months, at,
    }, `${this.base()}/settings/billing`);
    for (const o of await this.repo.owners(row.tenant_id)) {
      await this.repo.enqueueMail({
        tenantId: row.tenant_id, userId: o.id, to: o.email, ...letter, eventKey: 'billing.price_move',
        dedupKey: `billing:${row.tenant_id}:${o.id}:${moveKey(move.id)}`,
      }).catch(() => undefined);
    }
  }

  /** Письмо (и копия в центр/Telegram) всем владельцам компании. */
  private async notify(tenantId: string, kind: string, until: Date | null, dedup: string): Promise<void> {
    const letter = billingLetter(kind, until, `${this.base()}/settings/billing`);
    if (!letter) return;
    for (const o of await this.repo.owners(tenantId)) {
      await this.repo.enqueueMail({
        tenantId, userId: o.id, to: o.email, ...letter, eventKey: `billing.${kind}`, dedupKey: `billing:${tenantId}:${o.id}:${dedup}`,
      }).catch(() => undefined);
    }
  }

  // ───────────── вендор ─────────────

  plansAll() {
    return this.repo.plans(false);
  }

  planVersions(code: string) {
    return this.repo.planVersions(code);
  }

  priceMoves(code: string) {
    return this.repo.moves(code);
  }

  /**
   * Перевести оплаченные подписки тарифа на его ТЕКУЩУЮ версию с даты продления
   * applyFrom (§5.4). Цены фиксируются в переводе: следующая правка тарифа его не меняет.
   */
  async createPriceMove(code: string, applyFrom: string, note: string | null, by: string) {
    const plan = await this.repo.plan(code);
    if (!plan) throw AppException.notFound('Тариф не найден');
    const today = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // день по Москве
    if (!/^\d{4}-\d{2}-\d{2}$/.test(applyFrom) || applyFrom < today) throw AppException.validation('Дата перевода — сегодня или позже');
    const live = (await this.repo.activeMoves()).find((m) => m.plan_code === code && m.to_version === plan.version);
    if (live) throw AppException.conflict('На эту версию тарифа перевод уже назначен — отмените его, чтобы назначить заново');
    const id = await this.repo.createMove({
      planCode: code, toVersion: plan.version, priceMonth: plan.price_rub, priceYear: plan.price_year_rub, applyFrom, note, by,
    });
    // письма — сразу, не ждать часового прохода: от них считаются 14 дней
    void this.sweep(new Date()).catch((e) => this.log.warn(`письма о новой цене: ${(e as Error).message}`));
    return { id, toVersion: plan.version };
  }

  cancelPriceMove(id: string, by: string) {
    return this.repo.cancelMove(id, by);
  }

  async savePlan(p: {
    code: string; title: string; priceRub: number; priceYearRub?: number | null; maxMembers: number | null;
    description: string; sortOrder: number; isActive: boolean; changedBy?: string | null;
  }) {
    await this.repo.upsertPlan(p);
    return this.repo.plans(false);
  }

  async setByVendor(tenantId: string, p: { complimentary?: boolean; periodEnd?: Date | null; planCode?: string | null; trialEndsAt?: Date | null }) {
    await this.repo.setByVendor(tenantId, p);
    this.forget(tenantId);
    return this.view(tenantId);
  }
}
