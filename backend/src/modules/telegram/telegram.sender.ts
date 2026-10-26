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

  /**
   * Отправка с ответом, дошло ли (#1525: итоги клиенту). «blocked» — человек остановил
   * бота или удалил чат (Telegram отвечает 403/400 chat not found): туда больше не пишем.
   */
  async deliver(chatId: string | number, text: string): Promise<'ok' | 'blocked' | 'failed'> {
    if (!this.token) return 'failed';
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4096), disable_web_page_preview: true }),
      });
      if (res.ok) return 'ok';
      const json: any = await res.json().catch(() => null);
      const why = String(json?.description ?? '');
      return res.status === 403 || /chat not found|user is deactivated/i.test(why) ? 'blocked' : 'failed';
    } catch (e) {
      this.logger.warn(`deliver failed: ${(e as Error).message}`);
      return 'failed';
    }
  }

  /**
   * Вызов Bot API с ответом (#4619: кнопки бота, «печатает…», имя и описание бота).
   * Без токена — null; сбой сети или отказ Telegram — тоже null, с записью в журнал:
   * бот не должен ронять обработку вебхука из-за того, что Telegram не принял кнопку.
   */
  async call<T = unknown>(method: string, body: Record<string, unknown>): Promise<T | null> {
    if (!this.token) {
      this.logger.debug(`(no token) ${method}`);
      return null;
    }
    try {
      const res = await fetch(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      const json: any = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        this.logger.warn(`${method} отклонён: ${String(json?.description ?? res.status).slice(0, 200)}`);
        return null;
      }
      return json.result as T;
    } catch (e) {
      this.logger.warn(`${method} failed: ${(e as Error).message}`);
      return null;
    }
  }

  /** Скачать присланный файл (голосовое демо, #4619). Больше maxBytes — не качаем. */
  async fileBuffer(fileId: string, maxBytes = 8 * 1024 * 1024): Promise<Buffer | null> {
    const url = await this.fileUrl(fileId);
    if (!url) return null;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      return buf.length > maxBytes ? null : buf;
    } catch (e) {
      this.logger.warn(`download failed: ${(e as Error).message}`);
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
