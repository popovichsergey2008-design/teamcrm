import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/** Отправка сообщений в Telegram. No-op без TELEGRAM_BOT_TOKEN (dev/тесты). */
@Injectable()
export class TelegramSender {
  private readonly logger = new Logger('TelegramSender');
  private readonly token: string | undefined;

  constructor(config: ConfigService) {
    this.token = config.get<string>('TELEGRAM_BOT_TOKEN');
  }

  get enabled() {
    return !!this.token;
  }

  async sendMessage(chatId: string | number, text: string, replyMarkup?: unknown): Promise<void> {
    if (!this.token) {
      this.logger.debug(`(no token) -> ${chatId}: ${text.slice(0, 80)}`);
      return;
    }
    try {
      await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup }),
      });
    } catch (e) {
      this.logger.warn(`sendMessage failed: ${(e as Error).message}`);
    }
  }
}
