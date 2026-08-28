import { Injectable, Logger } from '@nestjs/common';
import { TelegramSender } from '../telegram/telegram.sender';
import { TelegramService } from '../telegram/telegram.service';
import { MailRow, NotificationsRepository } from './notifications.repository';
import { MIRROR_EVENT_KEY } from './mail.templates';
import { mirrorText } from './telegram-mirror.text';

/**
 * Дубль почтового уведомления в личный чат сотрудника с ботом.
 *
 * Почему в чат вообще: письмо доходит когда доходит — внешний сервис, спам-фильтр,
 * почта на телефоне, которую открывают вечером. О новой задаче или встрече через час
 * узнавать поздно. Сообщение боту приходит сразу и туда, куда человек смотрит.
 *
 * Почему здесь, а не в доменных сервисах: через очередь писем проходит ВСЁ, что мы
 * вообще шлём наружу. Дублируя тут, мы покрываем и задачи, и календарь, и любые
 * будущие письма — их авторам не придётся помнить про второй канал.
 *
 * Приватность: пишем только в личный чат человека, найденный по его собственной
 * привязке. Ни групп, ни общих каналов — уведомление видит адресат и никто больше.
 */
@Injectable()
export class TelegramMirror {
  private readonly log = new Logger('TelegramMirror');

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly telegram: TelegramService,
    private readonly sender: TelegramSender,
  ) {}

  /**
   * Сообщение сотруднику в его личный чат, без письма.
   *
   * Тем же каналом и с той же настройкой, что и дубли почты: человек один раз решил,
   * писать ли ему в Telegram, и решение должно действовать для всего, что мы шлём.
   * Возвращает, дошло ли, — зовущему это нужно, чтобы не считать доставленным то,
   * чего не было.
   */
  async push(tenantId: string, userId: string, text: string): Promise<boolean> {
    if (!this.sender.enabled || !userId || !text.trim()) return false;
    try {
      if (!(await this.repo.prefEnabled(tenantId, userId, MIRROR_EVENT_KEY))) return false;
      const chatId = await this.telegram.chatIdOf(tenantId, userId);
      if (!chatId) return false;
      await this.sender.sendMessage(chatId, text);
      return true;
    } catch (e) {
      this.log.warn(`сообщение в Telegram не ушло: ${(e as Error).message}`);
      return false;
    }
  }

  /**
   * Одно письмо — одно сообщение. Зовётся до попытки отправки почты намеренно:
   * если письмо не уйдёт (нет ключа, битый адрес, спам-фильтр), человек всё равно
   * узнает о событии. Ошибки глотаем — очередь писем из-за мессенджера стоять не должна.
   */
  async mirror(row: MailRow): Promise<void> {
    if (!this.sender.enabled || !row.user_id || row.tg_sent_at) return;
    try {
      if (!(await this.repo.prefEnabled(row.tenant_id, row.user_id, MIRROR_EVENT_KEY))) return;
      const chatId = await this.telegram.chatIdOf(row.tenant_id, row.user_id);
      if (!chatId) return; // Telegram не привязан — это норма, а не ошибка

      const text = mirrorText(row.subject, row.body_text);
      // Вложение (.ics встречи) в чат не тянем: файл лежит в письме, а в чате
      // человеку нужна сама новость и ссылка на карточку.
      const note = row.attachments?.length ? `${text}\n\nФайл встречи — в письме на почте.` : text;

      await this.sender.sendMessage(chatId, note);
      await this.repo.markTelegramSent(row.id);
    } catch (e) {
      this.log.warn(`дубль письма #${row.id} в Telegram не ушёл: ${(e as Error).message}`);
    }
  }
}
