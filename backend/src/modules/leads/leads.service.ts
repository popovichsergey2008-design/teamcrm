import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DbService } from '../../database/db.service';
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
  ip: string;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger('Leads');
  private readonly hits = new Map<string, number[]>();
  /** Куда сообщать о заявке. Пусто — заявка только сохраняется в landing_leads. */
  private readonly chatId: string | undefined;

  constructor(private readonly db: DbService, private readonly tg: TelegramSender, config: ConfigService) {
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
    await this.db.query(
      `INSERT INTO landing_leads (source, move_from, team_size, contact, page, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
      [l.source, l.from ?? null, l.team ?? null, contact, l.page ?? null, l.ip],
    );
    if (!this.chatId) return;
    const text = [
      'Заявка с сайта: план переезда',
      `Откуда: ${l.from ? FROM_LABEL[l.from] ?? l.from : 'не указано'}`,
      `Команда: ${l.team ?? 'не указано'}`,
      `Контакт: ${contact}`,
    ].join('\n');
    await this.tg.sendMessage(this.chatId, text).catch((e) => this.logger.warn(`notify failed: ${(e as Error).message}`));
  }
}
