import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { TgAccount, TelegramRepository } from './telegram.repository';

const CODE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class TelegramService {
  constructor(private readonly repo: TelegramRepository) {}

  /** Одноразовый код привязки (показывается в веб-CRM, отправляется боту). */
  async issueLinkCode(tenantId: string, userId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = randomBytes(5).toString('hex').toUpperCase(); // 10 hex-символов
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.repo.createLinkCode(tenantId, userId, code, expiresAt);
    return { code, expiresAt };
  }

  /** Личность актора определяется привязкой, НЕ содержимым голоса/LLM. */
  resolveActor(telegramUserId: string | number): Promise<TgAccount | null> {
    return this.repo.accountByTelegram(String(telegramUserId));
  }

  /** Привязка по коду; код одноразовый и истекающий. */
  async tryLink(telegramUserId: string | number, codeText: string): Promise<TgAccount | null> {
    const code = codeText.trim().toUpperCase();
    const found = await this.repo.findValidCode(code);
    if (!found) return null;
    await this.repo.linkAccount(found.tenant_id, found.user_id, String(telegramUserId), found.id);
    return { tenant_id: found.tenant_id, user_id: found.user_id, telegram_user_id: String(telegramUserId) };
  }
}
