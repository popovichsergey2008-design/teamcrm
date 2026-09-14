import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { IntegrationCryptoService } from '../integrations/crypto.service';

/** Значения по умолчанию: щедро для работы и достаточно скромно для счёта за модель. */
export const DEFAULT_LIMITS = {
  /** Вопросов к агенту на человека в сутки. */
  requestsPerDay: 100,
  /** Глубоких разборов в сутки: каждый — это до трёх волн поиска и длинный ответ. */
  deepPerDay: 5,
  /** Регулярных задач на человека: их выполняет сервер, и каждая тратит модель. */
  maxScheduled: 10,
  /** Навыков на человека. */
  maxSkills: 30,
  /** Сколько прошлых сообщений разговора уходит в подсказку. */
  contextMessages: 12,
};

export type AgentLimits = typeof DEFAULT_LIMITS;

export interface AgentSettings {
  enabled: boolean;
  allowedRoles: string[];
  webSearch: boolean;
  /** Ключ наружу не отдаём — только признак, что он задан. */
  hasWebSearchKey: boolean;
  filesAllowed: boolean;
  actionsAllowed: boolean;
  integrations: boolean;
  limits: AgentLimits;
}

interface Row {
  enabled: boolean; allowed_roles: string[]; web_search: boolean; web_search_key: string | null;
  files_allowed: boolean; actions_allowed: boolean; integrations: boolean; limits: Partial<AgentLimits>;
}

/**
 * Что агенту позволено в этой организации (ТЗ-6, разд. 52–53).
 *
 * Настройки читаются на КАЖДЫЙ вопрос, поэтому держим их в памяти минуту: запрос
 * дешёвый, но он был бы лишним на каждом нажатии Enter, а реакция на смену
 * настройки в пределах минуты человеку незаметна.
 *
 * Строки может не быть вовсе — это нормально: организация ничего не настраивала,
 * и тогда действуют значения по умолчанию. Заводить строку каждой организации
 * заранее незачем.
 */
@Injectable()
export class AnthillAdminService {
  private readonly log = new Logger('AnthillAdmin');
  private cache = new Map<string, { at: number; value: AgentSettings & { key: string | null } }>();
  private static readonly TTL_MS = 60_000;

  constructor(private readonly db: DbService, private readonly crypto: IntegrationCryptoService) {}

  async get(tenantId: string): Promise<AgentSettings> {
    const { key, ...rest } = await this.load(tenantId);
    void key;
    return rest;
  }

  /** Ключ веб-поиска — только для самого поиска, наружу он не уходит. */
  async webSearchKey(tenantId: string): Promise<string | null> {
    const s = await this.load(tenantId);
    return s.webSearch ? s.key : null;
  }

  private async load(tenantId: string): Promise<AgentSettings & { key: string | null }> {
    const hit = this.cache.get(tenantId);
    if (hit && Date.now() - hit.at < AnthillAdminService.TTL_MS) return hit.value;
    const row = await this.db.one<Row>(`SELECT * FROM ai_agent_settings WHERE tenant_id=$1`, [tenantId]);
    const value = {
      enabled: row?.enabled ?? true,
      allowedRoles: row?.allowed_roles ?? ['owner', 'manager', 'member'],
      webSearch: row?.web_search ?? false,
      hasWebSearchKey: !!row?.web_search_key,
      filesAllowed: row?.files_allowed ?? true,
      actionsAllowed: row?.actions_allowed ?? true,
      integrations: row?.integrations ?? false,
      limits: { ...DEFAULT_LIMITS, ...(row?.limits ?? {}) },
      key: row?.web_search_key ? this.decrypt(row.web_search_key) : null,
    };
    this.cache.set(tenantId, { at: Date.now(), value });
    return value;
  }

  private decrypt(enc: string): string | null {
    try { return this.crypto.decrypt(enc); } catch { return null; }
  }

  async save(tenantId: string, userId: string, patch: Partial<AgentSettings> & { webSearchKey?: string | null }): Promise<AgentSettings> {
    const roles = patch.allowedRoles
      ? patch.allowedRoles.filter((r) => ['owner', 'manager', 'member'].includes(r))
      : null;
    // «Никому» — не настройка, а поломка: такую организацию потом некому починить
    if (roles && !roles.length) throw AppException.validation('Оставьте хотя бы одну роль');
    const limits = patch.limits ? sanitizeLimits(patch.limits) : null;
    // Пустая строка в ключе означает «убрать ключ», отсутствие поля — «не трогать».
    const keyEnc = patch.webSearchKey === undefined ? undefined
      : (patch.webSearchKey ? this.crypto.encrypt(patch.webSearchKey.trim()) : null);

    await this.db.query(
      `INSERT INTO ai_agent_settings (tenant_id, enabled, allowed_roles, web_search, web_search_key,
                                      files_allowed, actions_allowed, integrations, limits, updated_by)
       VALUES ($1, COALESCE($2, true), COALESCE($3::jsonb, '["owner","manager","member"]'::jsonb), COALESCE($4, false), $5,
               COALESCE($6, true), COALESCE($7, true), COALESCE($8, false), COALESCE($9::jsonb, '{}'::jsonb), $10)
       ON CONFLICT (tenant_id) DO UPDATE SET
         enabled         = COALESCE($2, ai_agent_settings.enabled),
         allowed_roles   = COALESCE($3::jsonb, ai_agent_settings.allowed_roles),
         web_search      = COALESCE($4, ai_agent_settings.web_search),
         web_search_key  = CASE WHEN $11 THEN $5 ELSE ai_agent_settings.web_search_key END,
         files_allowed   = COALESCE($6, ai_agent_settings.files_allowed),
         actions_allowed = COALESCE($7, ai_agent_settings.actions_allowed),
         integrations    = COALESCE($8, ai_agent_settings.integrations),
         limits          = COALESCE($9::jsonb, ai_agent_settings.limits),
         updated_by      = $10,
         updated_at      = now()`,
      [tenantId,
        patch.enabled ?? null,
        roles ? JSON.stringify(roles) : null,
        patch.webSearch ?? null,
        keyEnc ?? null,
        patch.filesAllowed ?? null,
        patch.actionsAllowed ?? null,
        patch.integrations ?? null,
        limits ? JSON.stringify(limits) : null,
        userId,
        keyEnc !== undefined],
    );
    this.cache.delete(tenantId);
    this.log.log(`настройки агента обновлены (организация ${tenantId})`);
    return this.get(tenantId);
  }

  /**
   * Расход и сбои за две недели — то, по чему администратор решает, не пора ли
   * прикрутить лимиты. Токены берём из общего журнала расхода модели, сбои — из
   * действий, которые не выполнились, и из регулярных задач, упавших при запуске.
   */
  async usage(tenantId: string) {
    const [days, errors, failedTasks] = await Promise.all([
      this.db.many<{ day: string; requests: string; tokens: string; cost: string }>(
        `SELECT to_char(created_at, 'YYYY-MM-DD') AS day,
                COUNT(*)::text AS requests,
                SUM(input_tokens + output_tokens)::text AS tokens,
                ROUND(SUM(cost_estimate), 2)::text AS cost
           FROM ai_usage
          WHERE tenant_id=$1 AND feature LIKE 'anthill%' AND created_at > now() - interval '14 days'
          GROUP BY 1 ORDER BY 1 DESC`,
        [tenantId],
      ),
      this.db.many<{ id: string; tool: string; error: string; created_at: Date; who: string | null }>(
        `SELECT a.id, a.tool, a.error, a.created_at, u.full_name AS who
           FROM ai_tool_actions a LEFT JOIN users u ON u.id = a.user_id
          WHERE a.tenant_id=$1 AND a.status='failed' AND a.error IS NOT NULL
          ORDER BY a.id DESC LIMIT 20`,
        [tenantId],
      ),
      this.db.many<{ id: string; title: string; last_error: string; last_run_at: Date; who: string | null }>(
        `SELECT s.id, s.title, s.last_error, s.last_run_at, u.full_name AS who
           FROM ai_scheduled_tasks s LEFT JOIN users u ON u.id = s.user_id
          WHERE s.tenant_id=$1 AND s.last_error IS NOT NULL
          ORDER BY s.last_run_at DESC NULLS LAST LIMIT 20`,
        [tenantId],
      ),
    ]);
    return {
      days: days.map((d) => ({ day: d.day, requests: Number(d.requests), tokens: Number(d.tokens ?? 0), cost: Number(d.cost ?? 0) })),
      errors: [
        ...errors.map((e) => ({ kind: 'action' as const, id: String(e.id), title: e.tool, text: e.error, at: e.created_at, who: e.who })),
        ...failedTasks.map((t) => ({ kind: 'task' as const, id: String(t.id), title: t.title, text: t.last_error, at: t.last_run_at, who: t.who })),
      ].sort((a, b) => new Date(b.at ?? 0).getTime() - new Date(a.at ?? 0).getTime()).slice(0, 20),
    };
  }
}

/** Лимиты держим в разумных границах: ноль и миллион одинаково ломают работу. */
function sanitizeLimits(p: Partial<AgentLimits>): AgentLimits {
  const clamp = (v: unknown, min: number, max: number, def: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : def;
  };
  return {
    requestsPerDay: clamp(p.requestsPerDay, 5, 10_000, DEFAULT_LIMITS.requestsPerDay),
    deepPerDay: clamp(p.deepPerDay, 0, 200, DEFAULT_LIMITS.deepPerDay),
    maxScheduled: clamp(p.maxScheduled, 0, 200, DEFAULT_LIMITS.maxScheduled),
    maxSkills: clamp(p.maxSkills, 0, 500, DEFAULT_LIMITS.maxSkills),
    contextMessages: clamp(p.contextMessages, 2, 40, DEFAULT_LIMITS.contextMessages),
  };
}
