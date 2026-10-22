import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface ProposalRow {
  id: string;
  tenant_id: string;
  user_id: string;
  skill: string;
  kind: string;
  source_type: string;
  source_id: string;
  source_at: Date | null;
  source_label: string | null;
  source_link: string | null;
  title: string;
  summary: string;
  why: string;
  recommend: string;
  effect: string;
  priority: number;
  confidence: string;
  status: string;
  actions: { key: string; label: string; risk?: string; primary?: boolean; link?: string }[];
  payload: Record<string, unknown>;
  fingerprint: string;
  snooze_until: Date | null;
  expires_at: Date | null;
  notified_at: Date | null;
  seen_at: Date | null;
  resolved_at: Date | null;
  resolved_action: string | null;
  result_text: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewProposal {
  tenantId: string;
  userId: string;
  skill: string;
  kind?: string;
  sourceType: string;
  sourceId: string;
  sourceAt?: Date | string | null;
  sourceLabel?: string | null;
  sourceLink?: string | null;
  title: string;
  summary?: string;
  why?: string;
  recommend?: string;
  effect?: string;
  priority: number;
  confidence: number;
  actions: { key: string; label: string; risk?: string; primary?: boolean; link?: string }[];
  payload?: Record<string, unknown>;
  fingerprint: string;
  expiresAt?: Date | null;
}

export interface ProactivePrefs {
  level: string;
  dailyLimit: number;
  smartReply: boolean;
  morningAudio: boolean;
  /** #1525: время утреннего аудио-кофе (HH:MM), null — выключен; по умолчанию 09:00 */
  briefAt: string | null;
}

@Injectable()
export class ProactiveRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Новое предложение. Тот же отпечаток уже был (и не закрыт как «отложено») — ничего не
   * создаём: решённое не всплывает второй раз, открытое не дублируется (§107).
   */
  async insert(p: NewProposal): Promise<ProposalRow | null> {
    return this.db.one<ProposalRow>(
      `INSERT INTO assistant_proposals
         (tenant_id, user_id, skill, kind, source_type, source_id, source_at, source_label, source_link,
          title, summary, why, recommend, effect, priority, confidence, actions, payload, fingerprint, expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       ON CONFLICT (tenant_id, user_id, fingerprint) DO NOTHING
       RETURNING *`,
      [
        p.tenantId, p.userId, p.skill, p.kind ?? '', p.sourceType, String(p.sourceId), p.sourceAt ?? null,
        p.sourceLabel?.slice(0, 200) ?? null, p.sourceLink?.slice(0, 500) ?? null,
        p.title.slice(0, 200), p.summary ?? '', p.why ?? '', p.recommend ?? '', p.effect ?? '',
        Math.max(0, Math.min(3, Math.round(p.priority))), Math.max(0, Math.min(1, p.confidence)).toFixed(2),
        JSON.stringify(p.actions), JSON.stringify(p.payload ?? {}), p.fingerprint, p.expiresAt ?? null,
      ],
    );
  }

  async muted(tenantId: string, userId: string, skill: string, kind: string): Promise<boolean> {
    const row = await this.db.one<{ ok: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM assistant_proposal_mutes
                       WHERE tenant_id=$1 AND user_id=$2 AND skill=$3 AND (kind='' OR kind=$4)) AS ok`,
      [tenantId, userId, skill, kind],
    );
    return !!row?.ok;
  }

  async mute(tenantId: string, userId: string, skill: string, kind: string): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_proposal_mutes (tenant_id, user_id, skill, kind) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [tenantId, userId, skill, kind],
    );
  }

  async unmute(tenantId: string, userId: string, skill: string, kind: string): Promise<void> {
    await this.db.query(`DELETE FROM assistant_proposal_mutes WHERE tenant_id=$1 AND user_id=$2 AND skill=$3 AND kind=$4`, [tenantId, userId, skill, kind]);
  }

  mutes(tenantId: string, userId: string) {
    return this.db.many<{ skill: string; kind: string; created_at: Date }>(
      `SELECT skill, kind, created_at FROM assistant_proposal_mutes WHERE tenant_id=$1 AND user_id=$2 ORDER BY created_at DESC`,
      [tenantId, userId],
    );
  }

  /** Сколько предложений человек сегодня уже получил уведомлением — для дневного лимита. */
  async notifiedSince(tenantId: string, userId: string, since: Date): Promise<number> {
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM assistant_proposals WHERE tenant_id=$1 AND user_id=$2 AND notified_at >= $3`,
      [tenantId, userId, since],
    );
    return Number(row?.n ?? 0);
  }

  async markNotified(id: string): Promise<void> {
    await this.db.query(`UPDATE assistant_proposals SET notified_at = now() WHERE id = $1`, [id]);
  }

  /** Открытые (и отложенные, если просили) — для ящика. */
  open(tenantId: string, userId: string, withSnoozed: boolean) {
    return this.db.many<ProposalRow>(
      `SELECT * FROM assistant_proposals
        WHERE tenant_id=$1 AND user_id=$2
          AND (status IN ('new','seen') OR ($3::boolean AND status = 'snoozed'))
        ORDER BY priority, created_at DESC LIMIT 200`,
      [tenantId, userId, withSnoozed],
    );
  }

  /** История: что сделано, отклонено, истекло — за 30 дней. */
  history(tenantId: string, userId: string) {
    return this.db.many<ProposalRow>(
      `SELECT * FROM assistant_proposals
        WHERE tenant_id=$1 AND user_id=$2 AND status IN ('executed','dismissed','expired','failed')
          AND COALESCE(resolved_at, updated_at) > now() - interval '30 days'
        ORDER BY COALESCE(resolved_at, updated_at) DESC LIMIT 100`,
      [tenantId, userId],
    );
  }

  get(tenantId: string, userId: string, id: string) {
    return this.db.one<ProposalRow>(
      `SELECT * FROM assistant_proposals WHERE tenant_id=$1 AND user_id=$2 AND id=$3`,
      [tenantId, userId, id],
    );
  }

  /** Захват на выполнение — атомарно: двойное нажатие не выполнит действие дважды. */
  async claim(tenantId: string, userId: string, id: string): Promise<ProposalRow | null> {
    return this.db.one<ProposalRow>(
      `UPDATE assistant_proposals SET status = 'executing', updated_at = now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status IN ('new','seen','snoozed')
        RETURNING *`,
      [tenantId, userId, id],
    );
  }

  async finish(id: string, status: 'executed' | 'failed' | 'dismissed' | 'new', action: string | null, text: string | null, error: string | null = null): Promise<void> {
    await this.db.query(
      `UPDATE assistant_proposals SET status = $2::text, resolved_action = $3, result_text = $4, error = $5,
              resolved_at = CASE WHEN $2::text IN ('executed','failed','dismissed') THEN now() ELSE NULL END,
              updated_at = now()
        WHERE id = $1`,
      [id, status, action, text, error],
    );
  }

  /** Обновить данные карточки (черновики планерки: какой уже стал задачей). */
  async setPayload(id: string, payload: Record<string, unknown>): Promise<void> {
    await this.db.query(`UPDATE assistant_proposals SET payload = $2::jsonb, updated_at = now() WHERE id = $1`, [id, JSON.stringify(payload)]);
  }

  async dismiss(tenantId: string, userId: string, id: string): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE assistant_proposals SET status='dismissed', resolved_action='dismiss', resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status IN ('new','seen','snoozed')`,
      [tenantId, userId, id],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async snooze(tenantId: string, userId: string, id: string, until: Date): Promise<boolean> {
    const r = await this.db.query(
      `UPDATE assistant_proposals SET status='snoozed', snooze_until=$4, updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id=$3 AND status IN ('new','seen','snoozed')`,
      [tenantId, userId, id, until],
    );
    return (r.rowCount ?? 0) > 0;
  }

  async markSeen(tenantId: string, userId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.db.query(
      `UPDATE assistant_proposals SET status='seen', seen_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND user_id=$2 AND id = ANY($3::bigint[]) AND status='new'`,
      [tenantId, userId, ids],
    );
  }

  /** Срок «отложить» вышел — предложение возвращается в ящик новым. */
  wakeSnoozed() {
    return this.db.many<ProposalRow>(
      `UPDATE assistant_proposals SET status='new', snooze_until=NULL, updated_at=now()
        WHERE status='snoozed' AND snooze_until <= now()
        RETURNING *`,
    );
  }

  /** Неактуальное — истекает само: вчерашний «ответьте клиенту» сегодня уже шум. */
  async expire(): Promise<number> {
    const r = await this.db.query(
      `UPDATE assistant_proposals SET status='expired', resolved_at=now(), updated_at=now()
        WHERE status IN ('new','seen','snoozed') AND expires_at IS NOT NULL AND expires_at <= now()`,
    );
    return r.rowCount ?? 0;
  }

  /** Источник решён без нас (задача создана, ответ отправлен) — закрыть открытое предложение. */
  async resolveBySource(tenantId: string, skill: string, sourceType: string, sourceId: string, text: string): Promise<string[]> {
    const rows = await this.db.many<{ user_id: string }>(
      `UPDATE assistant_proposals SET status='executed', resolved_action='auto', result_text=$5, resolved_at=now(), updated_at=now()
        WHERE tenant_id=$1 AND skill=$2 AND source_type=$3 AND source_id=$4 AND status IN ('new','seen','snoozed')
        RETURNING user_id::text`,
      [tenantId, skill, sourceType, String(sourceId), text],
    );
    return [...new Set(rows.map((r) => r.user_id))];
  }

  async feedback(tenantId: string, userId: string, id: string, useful: boolean, reason: string | null): Promise<void> {
    await this.db.query(
      `INSERT INTO assistant_proposal_feedback (proposal_id, user_id, tenant_id, useful, reason) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (proposal_id, user_id) DO UPDATE SET useful = $4, reason = $5, created_at = now()`,
      [id, userId, tenantId, useful, reason],
    );
  }

  async counts(tenantId: string, userId: string) {
    return this.db.many<{ skill: string; priority: number; n: number }>(
      `SELECT skill, priority, count(*)::int AS n FROM assistant_proposals
        WHERE tenant_id=$1 AND user_id=$2 AND status IN ('new','seen')
        GROUP BY skill, priority`,
      [tenantId, userId],
    );
  }

  /** Метрики качества (§110) за период — по навыкам. */
  quality(tenantId: string, days: number) {
    return this.db.many<{ skill: string; total: number; executed: number; dismissed: number; expired: number; useful: number; useless: number }>(
      `SELECT p.skill, count(*)::int AS total,
              count(*) FILTER (WHERE p.status='executed')::int AS executed,
              count(*) FILTER (WHERE p.status='dismissed')::int AS dismissed,
              count(*) FILTER (WHERE p.status='expired')::int AS expired,
              count(f.*) FILTER (WHERE f.useful)::int AS useful,
              count(f.*) FILTER (WHERE NOT f.useful)::int AS useless
         FROM assistant_proposals p LEFT JOIN assistant_proposal_feedback f ON f.proposal_id = p.id
        WHERE p.tenant_id=$1 AND p.created_at > now() - ($2 || ' days')::interval
        GROUP BY p.skill ORDER BY p.skill`,
      [tenantId, String(days)],
    );
  }

  // ── настройки ──

  async prefs(tenantId: string, userId: string): Promise<ProactivePrefs> {
    const row = await this.db.one<{ proactive_level: string; proactive_daily_limit: number; smart_reply: boolean; morning_audio: boolean; brief_at: string | null }>(
      `SELECT proactive_level, proactive_daily_limit, smart_reply, morning_audio, to_char(brief_at, 'HH24:MI') AS brief_at
         FROM secretary_prefs WHERE user_id=$1 AND tenant_id=$2`,
      [userId, tenantId],
    );
    return {
      level: row?.proactive_level ?? 'normal',
      dailyLimit: Number(row?.proactive_daily_limit ?? 12),
      smartReply: row?.smart_reply ?? true,
      morningAudio: row?.morning_audio ?? true,
      briefAt: row ? row.brief_at : '09:00',
    };
  }

  async savePrefs(tenantId: string, userId: string, p: Partial<ProactivePrefs>): Promise<void> {
    await this.db.query(
      `INSERT INTO secretary_prefs (user_id, tenant_id, proactive_level, proactive_daily_limit, smart_reply, morning_audio)
       VALUES ($1,$2, COALESCE($3,'normal'), COALESCE($4,12), COALESCE($5,TRUE), COALESCE($6,TRUE))
       ON CONFLICT (user_id) DO UPDATE SET
         proactive_level = COALESCE($3, secretary_prefs.proactive_level),
         proactive_daily_limit = COALESCE($4, secretary_prefs.proactive_daily_limit),
         smart_reply = COALESCE($5, secretary_prefs.smart_reply),
         morning_audio = COALESCE($6, secretary_prefs.morning_audio),
         updated_at = now()`,
      [userId, tenantId, p.level ?? null, p.dailyLimit ?? null, p.smartReply ?? null, p.morningAudio ?? null],
    );
    // время аудио-кофе: undefined — не трогаем, null — выключить, 'HH:MM' — поставить
    if (p.briefAt !== undefined) {
      await this.db.query(`UPDATE secretary_prefs SET brief_at = $2::time, updated_at = now() WHERE user_id = $1`, [userId, p.briefAt]);
    }
  }

  async tenantSettings(tenantId: string) {
    const row = await this.db.one<Record<string, unknown>>(`SELECT * FROM proactive_settings WHERE tenant_id=$1`, [tenantId]);
    return {
      enabled: (row?.enabled as boolean) ?? true,
      commitments: (row?.commitments as boolean) ?? true,
      workloadGuard: (row?.workload_guard as boolean) ?? true,
      smartReply: (row?.smart_reply as boolean) ?? true,
      clientFollowup: (row?.client_followup as boolean) ?? true,
      morningAudio: (row?.morning_audio as boolean) ?? true,
      secondBrain: (row?.second_brain as boolean) ?? true,
      externalSend: (row?.external_send as boolean) ?? true,
      telegramDelivery: (row?.telegram_delivery as boolean) ?? true,
      commitmentCheckHours: Number(row?.commitment_check_hours ?? 24),
      commitmentEscalateHours: Number(row?.commitment_escalate_hours ?? 48),
      /** порог уверенности обещаний (этап 9): выше — меньше лишнего, но больше пропусков */
      commitmentMinConfidence: Number(row?.commitment_min_confidence ?? 0.7),
      /** дневные лимиты вызовов ИИ по навыкам на компанию (этап 10) */
      aiDailyLimits: { smart_reply: 300, client_followup: 30, morning_voice: 20, ...((row?.ai_daily_limits as Record<string, number>) ?? {}) },
    };
  }

  async saveTenantSettings(tenantId: string, s: Record<string, unknown>): Promise<void> {
    const cur = await this.tenantSettings(tenantId);
    const n = { ...cur, ...s };
    await this.db.query(
      `INSERT INTO proactive_settings (tenant_id, enabled, commitments, workload_guard, smart_reply, client_followup, morning_audio,
                                       second_brain, external_send, telegram_delivery, commitment_check_hours, commitment_escalate_hours,
                                       commitment_min_confidence, ai_daily_limits, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14::jsonb, now())
       ON CONFLICT (tenant_id) DO UPDATE SET enabled=$2, commitments=$3, workload_guard=$4, smart_reply=$5, client_followup=$6,
         morning_audio=$7, second_brain=$8, external_send=$9, telegram_delivery=$10, commitment_check_hours=$11,
         commitment_escalate_hours=$12, commitment_min_confidence=$13, ai_daily_limits=$14::jsonb, updated_at=now()`,
      [tenantId, n.enabled, n.commitments, n.workloadGuard, n.smartReply, n.clientFollowup, n.morningAudio,
        n.secondBrain, n.externalSend, n.telegramDelivery, n.commitmentCheckHours, n.commitmentEscalateHours,
        n.commitmentMinConfidence, JSON.stringify(n.aiDailyLimits ?? {})],
    );
  }

  /**
   * Не исчерпан ли дневной лимит навыка у компании (этап 10). Считаем по журналу расхода
   * ИИ за сутки — тем же, что в отчёте: один источник правды о том, сколько ушло.
   */
  async withinDailyLimit(tenantId: string, feature: string): Promise<boolean> {
    const s = await this.tenantSettings(tenantId);
    const limit = Number((s.aiDailyLimits as Record<string, number>)[feature] ?? 0);
    if (!limit) return true;
    const row = await this.db.one<{ n: number }>(
      `SELECT count(*)::int AS n FROM ai_usage WHERE tenant_id = $1 AND feature = $2 AND created_at > now() - interval '1 day'`,
      [tenantId, feature],
    );
    return (row?.n ?? 0) < limit;
  }

  /** Качество черновиков и обещаний (этап 9): что берут как есть, что правят, что возвращается. */
  async extraQuality(tenantId: string, days: number) {
    return this.db.one<{
      replies: number; accepted: number; edited: number; dismissed: number;
      commitments: number; fulfilled: number; untracked: number; reminded: number;
    }>(
      `SELECT
         (SELECT count(*) FROM smart_reply_drafts WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2))::int AS replies,
         (SELECT count(*) FROM smart_reply_drafts WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND outcome = 'accepted')::int AS accepted,
         (SELECT count(*) FROM smart_reply_drafts WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND outcome = 'edited')::int AS edited,
         (SELECT count(*) FROM smart_reply_drafts WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND outcome = 'dismissed')::int AS dismissed,
         (SELECT count(*) FROM commitments WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2))::int AS commitments,
         (SELECT count(*) FROM commitments WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND status = 'fulfilled')::int AS fulfilled,
         (SELECT count(*) FROM commitments WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND status = 'dismissed')::int AS untracked,
         (SELECT count(*) FROM commitments WHERE tenant_id = $1 AND created_at > now() - make_interval(days => $2) AND remind_count > 0)::int AS reminded`,
      [tenantId, days],
    );
  }

  async timezoneOf(tenantId: string, userId: string): Promise<string> {
    const row = await this.db.one<{ tz: string | null }>(
      `SELECT COALESCE(u.timezone, t.timezone) AS tz FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id=$1 AND u.tenant_id=$2`,
      [userId, tenantId],
    );
    return row?.tz || 'Europe/Moscow';
  }

  // ── «Ещё ждут решения» в других разделах (§80): счётчики шести прежних механизмов ──

  async elsewhere(tenantId: string, userId: string, boss: boolean) {
    const row = await this.db.one<{ pings: number; chat_actions: number; meeting_drafts: number; news: number }>(
      `SELECT
         (SELECT count(*)::int FROM assistant_pings p WHERE p.tenant_id=$1 AND p.user_id=$2 AND p.status='proposed') AS pings,
         (SELECT count(*)::int FROM chat_extracted_actions a
            JOIN chat_members cm ON cm.chat_id = a.chat_id AND cm.user_id = $2
           WHERE a.tenant_id=$1 AND a.status IN ('ready','needs_clarification')) AS chat_actions,
         (SELECT count(*)::int FROM meeting_task_drafts d JOIN meetings m ON m.id = d.meeting_id
           WHERE m.tenant_id=$1 AND d.status='pending' AND ($3::boolean OR m.created_by = $2::bigint)) AS meeting_drafts,
         (CASE WHEN $3::boolean THEN (SELECT count(*)::int FROM feed_candidates c WHERE c.tenant_id=$1 AND c.status='detected')
               + (SELECT count(*)::int FROM feed_posts fp WHERE fp.tenant_id=$1 AND fp.status='draft' AND fp.deleted_at IS NULL)
               ELSE 0 END) AS news`,
      [tenantId, userId, boss],
    );
    return {
      pings: Number(row?.pings ?? 0),
      chatActions: Number(row?.chat_actions ?? 0),
      meetingDrafts: Number(row?.meeting_drafts ?? 0),
      news: Number(row?.news ?? 0),
    };
  }
}
