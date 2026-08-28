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

  /**
   * Прямая ссылка на присланный файл.
   *
   * Телеграм даёт только идентификатор файла — по нему сначала нужно спросить путь,
   * и лишь потом скачивать. Без этого шага голосовой дейлик уходил в распознавание
   * идентификатором вместо звука и не распознавался вовсе.
   *
   * Ссылка живёт около часа, поэтому получаем её в момент обработки, а не при приёме.
   */
  async fileUrl(fileId: string): Promise<string | null> {
    if (!this.token || !fileId) return null;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getFile?file_id=${encodeURIComponent(fileId)}`);
      const json: any = await res.json();
      const path = json?.result?.file_path;
      return path ? `https://api.telegram.org/file/bot${this.token}/${path}` : null;
    } catch (e) {
      this.logger.warn(`getFile failed: ${(e as Error).message}`);
      return null;
    }
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
