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
  want?: 'video' | 'plan';
  contact: string;
  page?: string;
  message?: string;
  ip: string;
  /** Заявка из Telegram-бота (#4619): пространство, если уже заведено, и Telegram ID. */
  tenantId?: string | null;
  telegramUserId?: string | null;
  /** Строка контакта готова у вызывающего (бот знает ник и ссылку на чат). */
  contactLine?: string;
}

/** Срок плана переезда, обещанный на сайте: 24 часа от заявки, по Москве. */
function planDue(now: Date): string {
  return new Date(now.getTime() + 24 * 3600 * 1000).toLocaleString('ru-RU', {
    timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Сообщение дежурному о заявке (#4648). Человек на сайте выбрал сценарий — видео работы
 * приложения или план переезда, — и дежурный должен выполнить именно его: заголовок,
 * что сделать и к какому сроку различаются. Сами ролики и план отправляет человек:
 * написать в Telegram по нику или в WhatsApp бот первым не может.
 */
export function leadText(l: Pick<NewLead, 'source' | 'from' | 'team' | 'want' | 'message'>, contactLine: string, now = new Date()): string {
  if (l.source === 'support') {
    return [
      'Вопрос с сайта — проверка «ответ за 30 секунд», ответьте сейчас!',
      contactLine,
      `Вопрос: ${l.message?.trim() || '—'}`,
    ].join('\n');
  }
  const from = l.from ? FROM_LABEL[l.from] ?? l.from : 'не указано';
  // #4619: новое пространство из Telegram-бота — дежурному знать размер команды и написать
  if (l.source === 'telegram' && l.want !== 'plan') {
    return [
      'Новое пространство из Telegram-бота',
      'Что сделать: поздороваться, помочь с первыми задачами и предложить бесплатный переезд досок.',
      `Команда: ${l.team ?? 'не указано'}`,
      contactLine,
    ].join('\n');
  }
  const where = l.source === 'exit' ? ' (окно при уходе)' : l.source === 'telegram' ? ' (Telegram-бот)' : '';
  const todo = l.want === 'video'
    ? [
      `Заявка с сайта: прислать видео работы приложения${where}`,
      'Что сделать: отправьте короткие ролики QEVO — задачи из чатов, созвонов и голосовых. Сегодня, пока интерес не остыл.',
    ]
    : [
      `Заявка с сайта: план переезда${where}`,
      `Что сделать: план переезда из «${from}» и чек-лист миграции. Обещали за 24 часа — до ${planDue(now)} МСК.`,
    ];
  return [...todo, `Откуда: ${from}`, `Команда: ${l.team ?? 'не указано'}`, contactLine].join('\n');
}

/** #4779, п. 14: канал инженеров, куда сразу падает каждая заявка с сайта и из бота. */
export const LEADS_CHANNEL = 'Заявки с сайта и бота';

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
    const contactLine = l.contactLine ?? (phone ? `WhatsApp: ${contact} — https://wa.me/${digits.length === 11 && digits.startsWith('8') ? `7${digits.slice(1)}` : digits}` : `Telegram: ${contact}`);
    await this.db.query(
      `INSERT INTO landing_leads (source, move_from, team_size, contact, page, ip, message, want, tenant_id, telegram_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [l.source, l.from ?? null, l.team ?? null, contact, l.page ?? null, l.ip, l.message?.trim() || null, l.want ?? null,
        l.tenantId ?? null, l.telegramUserId ?? null],
    );
    const text = leadText(l, contactLine);
    await this.notify(text).catch((e) => this.logger.warn(`notify failed: ${(e as Error).message}`));
  }

  /**
   * Куда сообщить. Общий чат заявок задан — туда. Нет — каждому дежурному «Службы
   * заботы» с привязанным Telegram (#4616): вопрос «проверьте за 30 секунд» не должен
   * лечь в базу, где его никто не увидит.
   */
  private async notify(text: string): Promise<void> {
    const vendor = await this.platform.tenantId();
    // #4779, п. 14: каждая заявка — сразу в чат инженеров в QEVO площадки (канал «Заявки»),
    // а не только в личный Telegram дежурного: так её видят все инженеры и никто не пропустит
    if (vendor) await this.toEngineersChat(vendor, text).catch((e) => this.logger.warn(`чат инженеров: ${(e as Error).message}`));
    if (this.chatId) { await this.tg.sendMessage(this.chatId, text); return; }
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

  /**
   * Канал «Заявки» в пространстве площадки: создаётся при первой заявке, в нём все
   * инженеры техотдела (platform_staff). Сообщение — от QEVO Bot, со счётчиком
   * непрочитанного у каждого; новые инженеры добавляются при следующей заявке.
   */
  private async toEngineersChat(vendor: string, text: string): Promise<void> {
    const staff = (await this.platform.onDuty()).map((s) => String(s.user_id));
    if (!staff.length) return;
    let chat = await this.db.one<{ id: string }>(
      `SELECT id::text FROM chats WHERE tenant_id=$1 AND kind='channel' AND title=$2 ORDER BY id LIMIT 1`, [vendor, LEADS_CHANNEL],
    );
    if (!chat) {
      chat = await this.db.one<{ id: string }>(
        `INSERT INTO chats (tenant_id, kind, title, created_by) VALUES ($1, 'channel', $2, $3) RETURNING id::text`,
        [vendor, LEADS_CHANNEL, staff[0]],
      );
    }
    if (!chat) return;
    await this.db.query(
      `INSERT INTO chat_members (chat_id, user_id, tenant_id) SELECT $1::bigint, u, $2::bigint FROM unnest($3::bigint[]) AS u ON CONFLICT DO NOTHING`,
      [chat.id, vendor, staff],
    );
    await this.db.query(
      `INSERT INTO chat_messages (tenant_id, chat_id, author_id, body, is_ai) VALUES ($1, $2, NULL, $3, TRUE)`, [vendor, chat.id, text],
    );
    await this.db.query(`UPDATE chats SET last_message_at = now() WHERE id = $1`, [chat.id]);
  }
}
