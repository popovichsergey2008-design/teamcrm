import { Injectable } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { TgAccount, TelegramRepository } from './telegram.repository';

const CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Обработчик текста боту от модулей, которым нужен свой разговор (#1525: клиент по
 * ссылке t.me/бот?start=c_…). Вернул true — сообщение его, дейлик и привязка
 * сотрудника его не видят. staff — у чата есть привязка сотрудника CRM.
 */
export type TelegramTextHook = (chatId: string, text: string, ctx: { staff: boolean; name: string | null }) => Promise<boolean>;

@Injectable()
export class TelegramService {
  private readonly hooks: TelegramTextHook[] = [];

  constructor(private readonly repo: TelegramRepository) {}

  onText(h: TelegramTextHook): void {
    this.hooks.push(h);
  }

  /** Сообщение забрал один из обработчиков — дальше его не разбираем. Сбой обработчика — не его. */
  async handleExternal(chatId: string, text: string, ctx: { staff: boolean; name: string | null }): Promise<boolean> {
    for (const h of this.hooks) {
      if (await h(chatId, text, ctx).catch(() => false)) return true;
    }
    return false;
  }

  /** Одноразовый код привязки (показывается в веб-CRM, отправляется боту). */
  async issueLinkCode(tenantId: string, userId: string): Promise<{ code: string; expiresAt: Date }> {
    const code = randomBytes(5).toString('hex').toUpperCase(); // 10 hex-символов
    const expiresAt = new Date(Date.now() + CODE_TTL_MS);
    await this.repo.createLinkCode(tenantId, userId, code, expiresAt);
    return { code, expiresAt };
  }

  /**
   * Куда писать сотруднику.
   *
   * Раньше в качестве чата подставлялся ВНУТРЕННИЙ номер пользователя CRM («упрощение»
   * в коде) — и ответы бота уходили в никуда: человек присылал дейлик и не получал
   * ни разбора, ни кнопок подтверждения. Чат берётся из привязки; её нет — не пишем.
   */
  async chatIdOf(tenantId: string, userId: string): Promise<string | null> {
    const row = await this.repo.chatOf(tenantId, userId);
    return row?.telegram_user_id ? String(row.telegram_user_id) : null;
  }

  /** Отвязка: с этого момента бот человеку не пишет и его сообщений не принимает. */
  unlink(tenantId: string, userId: string): Promise<void> {
    return this.repo.unlink(tenantId, userId);
  }

  /** Личность актора определяется привязкой, НЕ содержимым голоса/LLM. */
  resolveActor(telegramUserId: string | number): Promise<TgAccount | null> {
    return this.repo.accountByTelegram(String(telegramUserId));
  }

  /** Привязка по коду; код одноразовый и истекающий. */
  async tryLink(telegramUserId: string | number, codeText: string): Promise<TgAccount | null> {
    // Ссылка t.me/бот?start=КОД (Qevo-бот, #4620) приходит сообщением «/start КОД»:
    // привязка в один клик, без переписывания кода руками.
    const code = codeText.trim().replace(/^\/start\s+/i, '').trim().toUpperCase();
    const found = await this.repo.findValidCode(code);
    if (!found) return null;
    await this.repo.linkAccount(found.tenant_id, found.user_id, String(telegramUserId), found.id);
    return { tenant_id: found.tenant_id, user_id: found.user_id, telegram_user_id: String(telegramUserId) };
  }
}
