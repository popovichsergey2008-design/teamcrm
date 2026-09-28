import { Injectable } from '@nestjs/common';
import { PoolClient } from 'pg';
import { DbService } from '../../database/db.service';

export interface SocialLinkRow {
  account_id: string;
  provider: string;
  external_id: string;
}

/** Куда ведёт привязка Telegram, сделанная из личного кабинета (этап 3). */
export interface TelegramMemberRow {
  tenant_id: string;
  user_id: string;
}

@Injectable()
export class SocialsRepository {
  constructor(private readonly db: DbService) {}

  findLink(provider: string, externalId: string): Promise<SocialLinkRow | null> {
    return this.db.one<SocialLinkRow>(
      `SELECT account_id, provider, external_id FROM account_socials
        WHERE provider = $1 AND external_id = $2`,
      [provider, externalId],
    );
  }

  /**
   * Привязать личность провайдера к аккаунту.
   *
   * Повторный вход не должен падать на уникальности, поэтому ON CONFLICT: если связка
   * уже есть - просто освежаем адрес. А вот увести чужую связку в свой аккаунт нельзя:
   * условие сверяет account_id, и при несовпадении строк не меняется ни одной.
   */
  async link(
    accountId: string,
    provider: string,
    externalId: string,
    email: string | null,
    client?: PoolClient,
  ): Promise<void> {
    const text = `
      INSERT INTO account_socials (account_id, provider, external_id, email)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (provider, external_id)
        DO UPDATE SET email = EXCLUDED.email
        WHERE account_socials.account_id = $1`;
    if (client) await client.query(text, [accountId, provider, externalId, email]);
    else await this.db.query(text, [accountId, provider, externalId, email]);
  }

  /**
   * Найти сотрудника по Telegram-аккаунту, привязанному через бота.
   *
   * Берём самую свежую привязку: человек может состоять в нескольких организациях, но
   * telegram_user_id уникален, так что строка тут ровно одна.
   */
  findTelegramMember(telegramUserId: string): Promise<TelegramMemberRow | null> {
    return this.db.one<TelegramMemberRow>(
      `SELECT ta.tenant_id, ta.user_id
         FROM telegram_accounts ta
         JOIN users u ON u.id = ta.user_id AND u.tenant_id = ta.tenant_id
        WHERE ta.telegram_user_id = $1 AND u.is_active = TRUE
        ORDER BY ta.linked_at DESC
        LIMIT 1`,
      [telegramUserId],
    );
  }
}
