import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';

/**
 * Действующие редакции политик (#4675).
 *
 * Те же номера — в `frontend/src/legal/index.ts` (LEGAL.*.version): там текст, который
 * человек читает. Поменяли текст — поднимите версию в ОБОИХ местах, иначе в журнал
 * ляжет не та редакция, с которой человек соглашался.
 */
export const POLICY_VERSIONS = { privacy: 'v2', remote_support: 'v2' } as const;
export type PolicyKind = keyof typeof POLICY_VERSIONS;

/**
 * Сколько живёт согласие на удалённую помощь.
 *
 * Политика удалённой поддержки: «Каждая сессия требует нового согласия», и сессия
 * «в любом случае» закрывается через 2 часа. Значит, согласие покрывает одну сессию
 * по одному обращению — показ экрана и доступ на 15 минут внутри этих двух часов —
 * и не переносится ни на другое обращение, ни на завтра.
 */
export const REMOTE_CONSENT_MS = 2 * 60 * 60 * 1000;

export const PRIVACY_REQUIRED = 'Чтобы зарегистрироваться, примите условия оферты и соглашений и дайте согласие на обработку персональных данных';

/**
 * Документы, которые человек принимает при регистрации (#4680) — те же, что в форме сайта
 * qevo.one, плюс Публичная оферта. Тексты живут на сайте; редакцию фиксируем датой проверки.
 */
export const SIGNUP_DOCUMENTS = [
  'https://qevo.one/legal/offer/',
  'https://qevo.one/legal/terms/',
  'https://qevo.one/legal/license/',
  'https://app.qevo.one/legal/privacy',
  'https://qevo.one/legal/consent/',
];
export const REMOTE_CONSENT_REQUIRED =
  'Сначала подтвердите согласие с Политикой удалённой поддержки — без него специалист не получит доступ';

export interface ConsentMeta { ip?: string | null; userAgent?: string | null }

/** Журнал согласий: кто, с какой редакцией, когда, откуда. Только запись и чтение. */
@Injectable()
export class PolicyConsentsService {
  constructor(private readonly db: DbService) {}

  /** Регистрация без галочки — понятный отказ 400, а не тихое создание аккаунта. */
  static assertPrivacy(accepted: unknown): void {
    if (accepted !== true) throw AppException.validation(PRIVACY_REQUIRED);
  }

  async record(
    input: { tenantId: string | number | null; userId: string | number | null; policy: PolicyKind; context?: Record<string, unknown> },
    meta?: ConsentMeta,
    client?: PoolClient,
  ): Promise<{ id: string; version: string; acceptedAt: string }> {
    const sql = `INSERT INTO policy_consents (tenant_id, user_id, policy, version, ip, user_agent, context)
                 VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                 RETURNING id::text, version, accepted_at`;
    // #4680: при регистрации галочки — за весь пакет документов сайта; в журнале видно, за какие
    const context = input.policy === 'privacy' ? { ...(input.context ?? {}), documents: SIGNUP_DOCUMENTS } : (input.context ?? {});
    const params = [
      input.tenantId == null ? null : String(input.tenantId),
      input.userId == null ? null : String(input.userId),
      input.policy,
      POLICY_VERSIONS[input.policy],
      meta?.ip ? String(meta.ip).slice(0, 64) : null,
      meta?.userAgent ? String(meta.userAgent).slice(0, 250) : null,
      JSON.stringify(context),
    ];
    const row = client
      ? (await client.query<{ id: string; version: string; accepted_at: Date | string }>(sql, params)).rows[0]
      : await this.db.one<{ id: string; version: string; accepted_at: Date | string }>(sql, params);
    return { id: row!.id, version: row!.version, acceptedAt: new Date(row!.accepted_at).toISOString() };
  }

  /**
   * Живое согласие на удалённую помощь по обращению: последнее за два часа, той же
   * редакции текста. Нет — вернётся null, и доступ не выдаётся.
   */
  async activeRemote(tenantId: string, userId: string, conversationId: string): Promise<{ id: string; acceptedAt: string; expiresAt: string } | null> {
    const row = await this.db.one<{ id: string; accepted_at: Date | string }>(
      `SELECT id::text, accepted_at FROM policy_consents
        WHERE tenant_id = $1 AND user_id = $2 AND policy = 'remote_support' AND version = $3
          AND context->>'conversationId' = $4::text
          AND accepted_at > now() - make_interval(secs => $5::int)
        ORDER BY accepted_at DESC LIMIT 1`,
      [tenantId, userId, POLICY_VERSIONS.remote_support, String(conversationId), Math.round(REMOTE_CONSENT_MS / 1000)],
    );
    if (!row) return null;
    const at = new Date(row.accepted_at).getTime();
    return { id: row.id, acceptedAt: new Date(at).toISOString(), expiresAt: new Date(at + REMOTE_CONSENT_MS).toISOString() };
  }
}
