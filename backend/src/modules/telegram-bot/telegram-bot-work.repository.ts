import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { TG_FOCUS_KEY } from '../notifications/mail.templates';
import { assigneeOwesSql, personalOverdueSql } from '../tasks/responsibility';
import { PENDING_MAX, StaffState } from './bot-work-rules';

export interface StateRow {
  mode: 'task' | 'daily' | null;
  mode_until: Date | null;
  pending_kind: 'ask' | 'return' | null;
  pending: any;
  pending_until: Date | null;
}

export interface TaskCardRow {
  id: string;
  title: string;
  project_id: string;
  project_name: string;
  assignee_name: string | null;
  deadline_at: Date | null;
  created_by: string | null;
  created_at: Date;
  approval_state: string;
}

/** Хранилище рабочего Telegram-бота (#4619, этап 4). */
@Injectable()
export class TelegramBotWorkRepository {
  constructor(private readonly db: DbService) {}

  // ───────────── короткая память о человеке ─────────────

  async state(tgId: string): Promise<(StaffState & { pending: any }) | null> {
    const r = await this.db.one<StateRow>(
      `SELECT mode, mode_until, pending_kind, pending, pending_until FROM telegram_bot_state WHERE telegram_user_id = $1`, [tgId],
    );
    return r ? { mode: r.mode, modeUntil: r.mode_until, pendingKind: r.pending_kind, pendingUntil: r.pending_until, pending: r.pending } : null;
  }

  /** Выбор «задача / дейлик» — на 10 минут. */
  async setMode(tgId: string, mode: 'task' | 'daily'): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_bot_state (telegram_user_id, mode, mode_until) VALUES ($1, $2::varchar, now() + interval '10 minutes')
       ON CONFLICT (telegram_user_id) DO UPDATE SET mode = EXCLUDED.mode, mode_until = EXCLUDED.mode_until, updated_at = now()`,
      [tgId, mode],
    );
  }

  /**
   * Сообщение ждёт выбора кнопкой. Серия копится (не больше PENDING_MAX), просроченная
   * серия и чужой ожидаемый ответ (причина возврата) заменяются новой.
   */
  async pushAsk(tgId: string, msg: Record<string, unknown>): Promise<number> {
    const r = await this.db.one<{ n: number }>(
      `INSERT INTO telegram_bot_state (telegram_user_id, pending_kind, pending, pending_until)
       VALUES ($1, 'ask', jsonb_build_array($2::jsonb), now() + interval '10 minutes')
       ON CONFLICT (telegram_user_id) DO UPDATE SET
         pending_kind = 'ask',
         pending = CASE
           WHEN telegram_bot_state.pending_kind = 'ask' AND telegram_bot_state.pending_until > now()
                AND jsonb_array_length(telegram_bot_state.pending) < $3::int
             THEN telegram_bot_state.pending || jsonb_build_array($2::jsonb)
           WHEN telegram_bot_state.pending_kind = 'ask' AND telegram_bot_state.pending_until > now()
             THEN telegram_bot_state.pending
           ELSE jsonb_build_array($2::jsonb) END,
         pending_until = now() + interval '10 minutes', updated_at = now()
       RETURNING jsonb_array_length(pending)::int AS n`,
      [tgId, JSON.stringify(msg), PENDING_MAX],
    );
    return r?.n ?? 1;
  }

  async setReturn(tgId: string, tenantId: string, taskId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO telegram_bot_state (telegram_user_id, pending_kind, pending, pending_until)
       VALUES ($1, 'return', $2::jsonb, now() + interval '10 minutes')
       ON CONFLICT (telegram_user_id) DO UPDATE SET pending_kind = 'return', pending = EXCLUDED.pending,
         pending_until = EXCLUDED.pending_until, updated_at = now()`,
      [tgId, JSON.stringify({ tenantId, taskId })],
    );
  }

  /** Забрать ожидаемое атомарно: два нажатия одной кнопки не обработают серию дважды. */
  async take(tgId: string, kind: 'ask' | 'return'): Promise<any | null> {
    const r = await this.db.one<{ pending: any }>(
      `UPDATE telegram_bot_state s SET pending_kind = NULL, pending = NULL, pending_until = NULL, updated_at = now()
         FROM (SELECT pending AS old FROM telegram_bot_state
                WHERE telegram_user_id = $1 AND pending_kind = $2::varchar AND pending_until > now() FOR UPDATE) p
        WHERE s.telegram_user_id = $1
        RETURNING p.old AS pending`,
      [tgId, kind],
    );
    return r?.pending ?? null;
  }

  // ───────────── задачи ─────────────

  taskCard(tenantId: string, taskId: string): Promise<TaskCardRow | null> {
    return this.db.one<TaskCardRow>(
      `SELECT t.id::text, t.title, t.project_id::text, p.name AS project_name, ua.full_name AS assignee_name,
              t.deadline_at, t.created_by::text, t.created_at, t.approval_state
         FROM tasks t JOIN projects p ON p.id = t.project_id
    LEFT JOIN users ua ON ua.id = t.assignee_id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL`,
      [tenantId, taskId],
    );
  }

  tzOf(tenantId: string, userId: string): Promise<string> {
    return this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.tenant_id = $1 AND u.id = $2`,
      [tenantId, userId],
    ).then((r) => r?.tz || 'Europe/Moscow');
  }

  /** Единственный открытый проект организации — запасной вариант, когда проект не угадан. */
  async onlyProject(tenantId: string): Promise<string | null> {
    const rows = await this.db.many<{ id: string }>(
      `SELECT id::text FROM projects WHERE tenant_id = $1 AND status <> 'archived' ORDER BY id LIMIT 2`, [tenantId],
    );
    return rows.length === 1 ? rows[0].id : null;
  }

  /** Кто решает по сданной работе: постановщик (не сам сдавший), активный, и его Telegram. */
  decider(tenantId: string, taskId: string, actorId: string | null): Promise<{ user_id: string; chat_id: string } | null> {
    return this.db.one<{ user_id: string; chat_id: string }>(
      `SELECT u.id::text AS user_id, ta.telegram_user_id::text AS chat_id
         FROM tasks t
         JOIN users u ON u.id = t.created_by AND u.tenant_id = t.tenant_id AND u.is_active = TRUE
         JOIN telegram_accounts ta ON ta.tenant_id = u.tenant_id AND ta.user_id = u.id
        WHERE t.tenant_id = $1 AND t.id = $2 AND t.deleted_at IS NULL
          AND ($3::bigint IS NULL OR t.created_by <> $3::bigint)`,
      [tenantId, taskId, actorId],
    );
  }

  /** Человек не выключил этот повод (строки нет — включено). */
  async prefOn(tenantId: string, userId: string, key: string): Promise<boolean> {
    const r = await this.db.one<{ enabled: boolean }>(
      `SELECT enabled FROM notification_prefs WHERE tenant_id = $1 AND user_id = $2 AND event_key = $3`, [tenantId, userId, key],
    );
    return r?.enabled ?? true;
  }

  // ───────────── «Фокус дня» в 09:30 ─────────────

  /** Владельцы и руководители с привязанным Telegram и включённым фокусом, кому сегодня ещё не слали. */
  focusCandidates(): Promise<{ tenant_id: string; user_id: string; chat_id: string; tz: string }[]> {
    return this.db.many(
      `SELECT u.tenant_id::text, u.id::text AS user_id, ta.telegram_user_id::text AS chat_id,
              COALESCE(u.timezone, t.timezone, 'Europe/Moscow') AS tz
         FROM telegram_accounts ta
         JOIN users u ON u.id = ta.user_id AND u.tenant_id = ta.tenant_id AND u.is_active = TRUE
         JOIN roles r ON r.id = u.role_id AND r.code IN ('owner', 'manager')
         JOIN tenants t ON t.id = u.tenant_id
    LEFT JOIN notification_prefs np ON np.tenant_id = u.tenant_id AND np.user_id = u.id AND np.event_key = $1
        WHERE COALESCE(np.enabled, TRUE)
          AND NOT EXISTS (SELECT 1 FROM secretary_sent x WHERE x.user_id = u.id AND x.kind = 'tg_focus'
                             AND x.ref >= to_char(current_date - 1, 'YYYY-MM-DD'))`,
      [TG_FOCUS_KEY],
    );
  }

  /** Один фокус в день даже при двух экземплярах API во время выкладки. */
  async claimFocus(userId: string, day: string): Promise<boolean> {
    const r = await this.db.query(`INSERT INTO secretary_sent (user_id, kind, ref) VALUES ($1, 'tg_focus', $2) ON CONFLICT DO NOTHING`, [userId, day]);
    return !!r.rowCount;
  }

  async releaseFocus(userId: string, day: string): Promise<void> {
    await this.db.query(`DELETE FROM secretary_sent WHERE user_id = $1 AND kind = 'tg_focus' AND ref = $2`, [userId, day]);
  }

  /** Утренний голосовой бриф 09:00 сегодня уже ушёл в Telegram (MorningVoiceService). */
  async morningInTelegram(userId: string, day: string): Promise<boolean> {
    return !!(await this.db.one(`SELECT 1 FROM secretary_sent WHERE user_id = $1 AND kind = 'morning_tg' AND ref = $2`, [userId, day]));
  }

  /**
   * Факты фокуса. Руководитель видит все открытые проекты (как утренний бриф).
   * «Рискует сорвать срок» — личная просрочка движка ответственности (ТЗ-30) на конец
   * дня: задача сейчас у исполнителя, и его срок пройдёт к вечеру или уже прошёл.
   */
  async focusFacts(tenantId: string, userId: string, dayStart: Date, dayEnd: Date, now: Date) {
    const OPEN = `t.tenant_id = $1 AND t.deleted_at IS NULL AND t.closed_at IS NULL
      AND EXISTS (SELECT 1 FROM projects p WHERE p.id = t.project_id AND p.status <> 'archived')`;
    const [top, topCount, risk, meetings] = await Promise.all([
      this.db.many<{ title: string }>(
        `SELECT t.title FROM tasks t
          WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at >= $2 AND t.deadline_at < $3
          ORDER BY (t.priority = 'urgent') DESC, (t.priority = 'high') DESC, t.deadline_at LIMIT 3`,
        [tenantId, dayStart, dayEnd],
      ),
      this.db.one<{ n: number }>(
        `SELECT count(*)::int AS n FROM tasks t
          WHERE ${OPEN} AND ${assigneeOwesSql('t')} AND t.deadline_at >= $2 AND t.deadline_at < $3`,
        [tenantId, dayStart, dayEnd],
      ),
      this.db.many<{ name: string; n: number }>(
        `SELECT u.full_name AS name, count(*)::int AS n
           FROM tasks t JOIN users u ON u.id = t.assignee_id AND u.is_active = TRUE
          WHERE ${OPEN} AND ${personalOverdueSql('t', '$2::timestamptz')}
          GROUP BY u.id, u.full_name ORDER BY count(*) DESC, u.full_name LIMIT 10`,
        [tenantId, dayEnd],
      ),
      this.db.many<{ title: string; starts_at: Date }>(
        `SELECT e.title, e.starts_at FROM calendar_events e
           JOIN calendar_participants p ON p.event_id = e.id AND p.user_id = $2
          WHERE e.tenant_id = $1 AND e.starts_at >= $3 AND e.starts_at < $4 AND p.status <> 'declined'
          ORDER BY e.starts_at LIMIT 3`,
        [tenantId, userId, now, dayEnd],
      ),
    ]);
    return { top: top.map((x) => x.title), topTotal: topCount?.n ?? top.length, risk, meetings };
  }

  // ───────────── переезд на 4-й день ─────────────

  /**
   * Организации в окне 4–7-го дня пробного периода (или с создания — у тех, кто пришёл не
   * через бота), кому ещё не предлагали, с владельцем, привязавшим Telegram.
   */
  moveCandidates(now: Date): Promise<{
    tenant_id: string; user_id: string; chat_id: string; tz: string; started_at: Date; imported: boolean; plan_lead: boolean;
  }[]> {
    return this.db.many(
      `SELECT DISTINCT ON (t.id) t.id::text AS tenant_id, u.id::text AS user_id, ta.telegram_user_id::text AS chat_id,
              COALESCE(u.timezone, t.timezone, 'Europe/Moscow') AS tz,
              COALESCE(t.trial_started_at, t.created_at) AS started_at,
              (t.boards_imported_at IS NOT NULL
                OR EXISTS (SELECT 1 FROM projects p WHERE p.tenant_id = t.id AND p.origin <> 'local')
                OR EXISTS (SELECT 1 FROM integration_connections c WHERE c.tenant_id = t.id)) AS imported,
              EXISTS (SELECT 1 FROM landing_leads l WHERE l.tenant_id = t.id AND l.want = 'plan') AS plan_lead
         FROM tenants t
         JOIN users u ON u.tenant_id = t.id AND u.is_active = TRUE
         JOIN roles r ON r.id = u.role_id AND r.code = 'owner'
         JOIN telegram_accounts ta ON ta.tenant_id = t.id AND ta.user_id = u.id
        WHERE t.move_offer_sent_at IS NULL AND NOT t.is_platform
          AND COALESCE(t.trial_started_at, t.created_at) <= $1::timestamptz - interval '3 days'
          AND COALESCE(t.trial_started_at, t.created_at) > $1::timestamptz - interval '7 days'
        ORDER BY t.id, u.id`,
      [now],
    );
  }

  /** Захват «предложили» — второй экземпляр API второе сообщение не пошлёт. */
  async claimMoveOffer(tenantId: string): Promise<boolean> {
    return !!(await this.db.one(
      `UPDATE tenants SET move_offer_sent_at = now() WHERE id = $1 AND move_offer_sent_at IS NULL RETURNING id`, [tenantId],
    ));
  }
}
