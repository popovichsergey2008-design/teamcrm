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
   * Имя бота для ссылки «открыть чат». Спрашиваем у самого Telegram, а не держим
   * в настройках: бот один раз меняют — и ссылка ведёт в чужой чат, чего никто
   * не заметит. Ответ не меняется, поэтому запоминаем до перезапуска.
   */
  private cachedName?: string | null;

  async username(): Promise<string | null> {
    if (!this.token) return null;
    if (this.cachedName !== undefined) return this.cachedName;
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/getMe`);
      const json: any = await res.json();
      this.cachedName = (json?.result?.username as string | undefined) ?? null;
    } catch (e) {
      this.logger.warn(`getMe failed: ${(e as Error).message}`);
      return null; // не запоминаем: связь могла лечь на секунду
    }
    return this.cachedName ?? null;
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

  /**
   * Голосовое сообщение (ТЗ-21, утренний бриф): MP3 файлом, с подписью. Telegram
   * принимает голосовые в OGG/OPUS, MP3 и M4A. Возвращает, ушло ли.
   */
  async sendVoice(chatId: string | number, audio: Buffer, caption?: string): Promise<boolean> {
    if (!this.token) return false;
    try {
      const form = new FormData();
      form.append('chat_id', String(chatId));
      form.append('voice', new Blob([new Uint8Array(audio)], { type: 'audio/mpeg' }), 'brief.mp3');
      if (caption) form.append('caption', caption.slice(0, 1000));
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendVoice`, { method: 'POST', body: form });
      return res.ok;
    } catch (e) {
      this.logger.warn(`sendVoice failed: ${(e as Error).message}`);
      return false;
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
