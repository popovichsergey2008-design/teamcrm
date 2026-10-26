import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import type { DemoCard } from './bot-demo-rules';

export interface BotUserRow {
  telegram_user_id: string;
  first_name: string | null;
  username: string | null;
  tenant_id: string | null;
  user_id: string | null;
  team_size: string | null;
}

export interface DemoRow {
  id: string;
  telegram_user_id: string;
  card: DemoCard;
  claimed_task_id: string | null;
}

/** Хранилище Telegram-бота (#4619): люди в боте, попытки демо, коды входа, пробный период. */
@Injectable()
export class TelegramBotRepository {
  constructor(private readonly db: DbService) {}

  /** Запомнить человека и метку источника (первую — навсегда, последнюю — каждый раз). */
  async touchUser(tgId: string, firstName: string | null, username: string | null, source: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_bot_users (telegram_user_id, first_name, username, first_source, last_source)
       VALUES ($1, $2, $3, $4::varchar, $4::varchar)
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         first_name = COALESCE(EXCLUDED.first_name, telegram_bot_users.first_name),
         username = COALESCE(EXCLUDED.username, telegram_bot_users.username),
         first_source = COALESCE(telegram_bot_users.first_source, EXCLUDED.first_source),
         last_source = COALESCE(EXCLUDED.last_source, telegram_bot_users.last_source),
         updated_at = now()`,
      [tgId, firstName?.slice(0, 120) ?? null, username?.slice(0, 64) ?? null, source],
    );
  }

  botUser(tgId: string): Promise<BotUserRow | null> {
    return this.db.one<BotUserRow>(
      `SELECT telegram_user_id::text, first_name, username, tenant_id::text, user_id::text, team_size
         FROM telegram_bot_users WHERE telegram_user_id = $1`, [tgId],
    );
  }

  async setSpace(tgId: string, tenantId: string, userId: string): Promise<void> {
    await this.db.query(
      `UPDATE telegram_bot_users SET tenant_id = $2, user_id = $3, updated_at = now() WHERE telegram_user_id = $1`,
      [tgId, tenantId, userId],
    );
  }

  /** Размер команды: вернёт прежний (null — отвечает впервые). */
  async setTeamSize(tgId: string, size: string): Promise<string | null> {
    const row = await this.db.one<{ prev: string | null }>(
      `UPDATE telegram_bot_users u SET team_size = $2, updated_at = now()
         FROM (SELECT team_size AS prev FROM telegram_bot_users WHERE telegram_user_id = $1) p
        WHERE u.telegram_user_id = $1
        RETURNING p.prev`, [tgId, size],
    );
    return row?.prev ?? null;
  }

  /** Сколько попыток демо у человека за сутки и сколько обращений к модели всего за сутки. */
  async demoCounts(tgId: string): Promise<{ user: number; ai: number }> {
    const row = await this.db.one<{ user_n: string; ai_n: string }>(
      `SELECT
         (SELECT count(*) FROM telegram_bot_demos
           WHERE telegram_user_id = $1 AND input_kind <> 'example' AND created_at > now() - interval '24 hours') AS user_n,
         (SELECT count(*) FROM telegram_bot_demos
           WHERE mode = 'ai' AND created_at > now() - interval '24 hours') AS ai_n`, [tgId],
    );
    return { user: Number(row?.user_n ?? 0), ai: Number(row?.ai_n ?? 0) };
  }

  async saveDemo(d: {
    tgId: string; kind: 'text' | 'forward' | 'voice' | 'example'; mode: 'ai' | 'rules'; card: DemoCard;
    audioSeconds: number | null; elapsedMs: number; cost: number;
  }): Promise<string> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO telegram_bot_demos (telegram_user_id, input_kind, mode, card, audio_seconds, elapsed_ms, cost_estimate)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7) RETURNING id::text`,
      [d.tgId, d.kind, d.mode, JSON.stringify(d.card), d.audioSeconds, Math.round(d.elapsedMs), d.cost],
    );
    return row!.id;
  }

  /** Карточка этого человека (чужую по номеру из кнопки не отдаём); нет номера — последняя. */
  demoOf(tgId: string, demoId: string | null): Promise<DemoRow | null> {
    return this.db.one<DemoRow>(
      `SELECT id::text, telegram_user_id::text, card, claimed_task_id::text FROM telegram_bot_demos
        WHERE telegram_user_id = $1 AND ($2::bigint IS NULL OR id = $2::bigint)
        ORDER BY id DESC LIMIT 1`,
      [tgId, demoId && /^\d+$/.test(demoId) && demoId !== '0' ? demoId : null],
    );
  }

  lastDemoId(tgId: string): Promise<string | null> {
    return this.db.one<{ id: string }>(
      `SELECT id::text FROM telegram_bot_demos WHERE telegram_user_id = $1 ORDER BY id DESC LIMIT 1`, [tgId],
    ).then((r) => r?.id ?? null);
  }

  async claimDemo(demoId: string, taskId: string): Promise<void> {
    await this.db.query(`UPDATE telegram_bot_demos SET claimed_task_id = $2 WHERE id = $1 AND claimed_task_id IS NULL`, [demoId, taskId]);
  }

  /** Привязать Telegram к сотруднику, только если он ни к кому не привязан (не угоняем). */
  async linkIfFree(tenantId: string, userId: string, tgId: string): Promise<boolean> {
    const row = await this.db.one<{ id: string }>(
      `INSERT INTO telegram_accounts (tenant_id, user_id, telegram_user_id) VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING RETURNING id::text`, [tenantId, userId, tgId],
    );
    return !!row;
  }

  /** Пробный период 7 дней с этой минуты; уже начатый не трогаем. */
  async startTrial(tenantId: string, days: number, source: string): Promise<void> {
    await this.db.query(
      `UPDATE tenants SET trial_started_at = COALESCE(trial_started_at, now()),
              trial_ends_at = COALESCE(trial_ends_at, now() + make_interval(days => $2::int)),
              source = COALESCE(source, $3::varchar), updated_at = now()
        WHERE id = $1`, [tenantId, days, source],
    );
  }

  /** Бонус за бота — один раз. */
  async addTrialBonus(tenantId: string, days: number): Promise<void> {
    await this.db.query(
      `UPDATE tenants SET trial_bonus_days = $2::int, trial_ends_at = trial_ends_at + make_interval(days => $2::int), updated_at = now()
        WHERE id = $1 AND trial_bonus_days = 0 AND trial_ends_at IS NOT NULL`, [tenantId, days],
    );
  }

  trialOf(tenantId: string): Promise<{ trial_ends_at: Date | null } | null> {
    return this.db.one<{ trial_ends_at: Date | null }>(`SELECT trial_ends_at FROM tenants WHERE id = $1`, [tenantId]);
  }

  async createLoginCode(codeHash: string, tgId: string, tenantId: string, userId: string, expiresAt: Date): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_login_codes (code_hash, telegram_user_id, tenant_id, user_id, expires_at) VALUES ($1, $2, $3, $4, $5)`,
      [codeHash, tgId, tenantId, userId, expiresAt],
    );
  }

  /** Погасить код атомарно: второй обмен того же кода ничего не вернёт. */
  consumeLoginCode(codeHash: string): Promise<{ tenant_id: string; user_id: string; telegram_user_id: string } | null> {
    return this.db.one(
      `UPDATE telegram_login_codes SET used_at = now()
        WHERE code_hash = $1 AND used_at IS NULL AND expires_at > now()
        RETURNING tenant_id::text, user_id::text, telegram_user_id::text`, [codeHash],
    );
  }

  /** Заявка на переезд от этого человека за последние 10 минут — повтор не шлём дежурным. */
  async recentPlanLead(tgId: string): Promise<boolean> {
    return !!(await this.db.one(
      `SELECT 1 FROM landing_leads WHERE telegram_user_id = $1 AND want = 'plan' AND created_at > now() - interval '10 minutes' LIMIT 1`, [tgId],
    ));
  }

  /** Аккаунт этого Telegram: вход через Telegram (account_socials) или служебная почта бота. */
  accountForTelegram(tgId: string, serviceEmail: string): Promise<string | null> {
    return this.db.one<{ id: string }>(
      `SELECT account_id::text AS id FROM account_socials WHERE provider = 'telegram' AND external_id = $1::text
       UNION ALL
       SELECT id::text FROM accounts WHERE lower(email) = lower($2::text)
       LIMIT 1`, [tgId, serviceEmail],
    ).then((r) => r?.id ?? null);
  }

  roleOf(tenantId: string, userId: string): Promise<{ role_code: string; full_name: string } | null> {
    return this.db.one<{ role_code: string; full_name: string }>(
      `SELECT r.code AS role_code, u.full_name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id = $1 AND u.id = $2 AND u.is_active`, [tenantId, userId],
    );
  }
}
