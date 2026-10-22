import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../../database/db.service';
import { PlatformService } from '../platform/platform.service';
import { TelegramService } from '../telegram/telegram.service';
import { TelegramSender } from '../telegram/telegram.sender';

const FROM_LABEL: Record<string, string> = {
  bitrix24: 'Битрикс24', yougile: 'YouGile', jira: 'Jira', trello: 'Trello', other: 'другое',
};

/** Не больше 5 заявок с адреса за 10 минут: страница открыта всем, вход не нужен. */
const WINDOW_MS = 10 * 60 * 1000;
const PER_WINDOW = 5;

export interface NewLead {
  source: string;
  from?: string;
  team?: string;
  contact: string;
  page?: string;
  message?: string;
  ip: string;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger('Leads');
  private readonly hits = new Map<string, number[]>();
  /** Куда сообщать о заявке. Пусто — пишем лично дежурным «Службы заботы» в их Telegram. */
  private readonly chatId: string | undefined;

  constructor(
    private readonly db: DbService,
    private readonly tg: TelegramSender,
    private readonly telegram: TelegramService,
    private readonly platform: PlatformService,
    config: ConfigService,
  ) {
    this.chatId = config.get<string>('LEADS_TELEGRAM_CHAT_ID') || undefined;
  }

  allow(ip: string, now = Date.now()): boolean {
    const recent = (this.hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= PER_WINDOW) return false;
    recent.push(now);
    this.hits.set(ip, recent);
    if (this.hits.size > 5000) this.hits.clear(); // память не растёт от перебора адресов
    return true;
  }

  async create(l: NewLead) {
    const contact = l.contact.trim();
    // номер с сайта — это WhatsApp (#4628): дежурному сразу ссылка, чтобы написать в один тап
    const digits = contact.replace(/\D/g, '');
    const phone = !contact.startsWith('@') && digits.length >= 10 && digits.length <= 15;
    const contactLine = phone ? `WhatsApp: ${contact} — https://wa.me/${digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits}` : `Telegram: ${contact}`;
    await this.db.query(
      `INSERT INTO landing_leads (source, move_from, team_size, contact, page, ip, message) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [l.source, l.from ?? null, l.team ?? null, contact, l.page ?? null, l.ip, l.message?.trim() || null],
    );
    const text = l.source === 'support' ? [
      'Вопрос с сайта — проверка «ответ за 30 секунд», ответьте сейчас!',
      contactLine,
      `Вопрос: ${l.message?.trim() || '—'}`,
    ].join('\n') : [
      'Заявка с сайта: план переезда',
      `Откуда: ${l.from ? FROM_LABEL[l.from] ?? l.from : 'не указано'}`,
      `Команда: ${l.team ?? 'не указано'}`,
      contactLine,
    ].join('\n');
    await this.notify(text).catch((e) => this.logger.warn(`notify failed: ${(e as Error).message}`));
  }

  /**
   * Куда сообщить. Общий чат заявок задан — туда. Нет — каждому дежурному «Службы
   * заботы» с привязанным Telegram (#4616): вопрос «проверьте за 30 секунд» не должен
   * лечь в базу, где его никто не увидит.
   */
  private async notify(text: string): Promise<void> {
    if (this.chatId) { await this.tg.sendMessage(this.chatId, text); return; }
    const vendor = await this.platform.tenantId();
    if (!vendor) return;
    let sent = 0;
    for (const s of await this.platform.onDuty()) {
      const chat = await this.telegram.chatIdOf(vendor, String(s.user_id)).catch(() => null);
      if (!chat) continue;
      await this.tg.sendMessage(chat, text);
      sent++;
    }
    if (!sent) this.logger.warn('заявку с сайта некому показать: нет LEADS_TELEGRAM_CHAT_ID и у дежурных не привязан Telegram');
  }
}
