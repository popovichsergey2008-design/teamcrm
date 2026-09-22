import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { NotificationsRepository } from './notifications.repository';
import { createTransport, MailPermanentError, MailTransport } from './mail.transport';
import { TelegramMirror } from './telegram-mirror.service';
import { PushService } from './push.service';

const BATCH = 20;
const MAX_ATTEMPTS = 6;

/**
 * Отправка писем из очереди.
 *
 * Отдельно от доменной логики намеренно: почтовый сервис может не ответить,
 * и ждать его в момент, когда человек нажал «создать задачу», нельзя.
 * Повторы с нарастающей паузой; отказ, связанный с самим письмом
 * (адрес, ключ, домен), помечается сразу — повторять его бессмысленно.
 */
@Injectable()
export class MailWorker implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('MailWorker');
  private timer?: NodeJS.Timeout;
  /** Идущий проход: второй вызов не запускает параллельный, а ждёт этот. */
  private inflight: Promise<number> | null = null;
  private transport: MailTransport = createTransport(process.env);

  constructor(
    private readonly repo: NotificationsRepository,
    private readonly mirror: TelegramMirror,
    private readonly push: PushService,
  ) {}

  onModuleInit() {
    if (process.env.MAIL_DISABLED === '1') return;
    void this.repo.requeueStuck().catch(() => undefined);
    const ms = Math.max(500, Number(process.env.MAIL_INTERVAL_MS ?? 5000));
    this.timer = setInterval(() => void this.tick(), ms);
    this.timer.unref?.(); // не держим процесс в тестах и CLI
    this.log.log(`почтовый транспорт: ${this.transport.name}`);
  }
  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Один проход очереди. Публичный — тесты зовут напрямую, не дожидаясь таймера.
   *
   * Если проход уже идёт (таймер успел раньше), дожидаемся его и проходим ещё раз:
   * тот проход мог начаться до того, как появилось письмо вызвавшего, и вернуть ноль
   * сразу или отдать чужое обещание — значит прочитать пустой ящик за мгновение до
   * того, как его заполнят. Вызвавшему гарантирован проход, начатый после вызова.
   */
  tick(): Promise<number> {
    if (this.inflight) return this.inflight.then(() => this.tick());
    this.inflight = this.pass().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async pass(): Promise<number> {
    let sent = 0;
    try {
      for (const row of await this.repo.claim(BATCH)) {
        // Дубль в мессенджер — раньше письма и независимо от его судьбы: если почта
        // не уйдёт вовсе, человек всё равно узнает о задаче или встрече.
        await this.mirror.mirror(row);
        // Ящик и push — тоже до письма (ТЗ-9): телефон узнаёт о событии, даже если почта легла.
        await this.push.deliver(row);
        try {
          await this.transport.send({
            to: row.to_email, subject: row.subject, text: row.body_text, html: row.body_html,
            attachments: row.attachments ?? null,
          });
          await this.repo.done(row.id);
          sent++;
        } catch (e) {
          const permanent = e instanceof MailPermanentError || row.attempts >= MAX_ATTEMPTS;
          const msg = (e as Error).message;
          if (permanent) this.log.warn(`письмо #${row.id} отброшено: ${msg}`);
          await this.repo.fail(row.id, msg, permanent ? null : Math.min(900, 10 * 2 ** row.attempts));
        }
      }
    } catch (e) {
      this.log.warn(`проход очереди не удался: ${(e as Error).message}`);
    }
    return sent;
  }
}
