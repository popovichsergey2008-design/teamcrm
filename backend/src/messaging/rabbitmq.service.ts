import {
  Global,
  Injectable,
  Logger,
  Module,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as amqp from 'amqplib';

export const Q_ECONOMICS = 'economics';
export const Q_AI_STANDUP = 'ai_standup';
export const Q_ANALYTICS = 'analytics';
export const Q_AI_ASSIST = 'ai_assist';
export const Q_EMBEDDINGS = 'embeddings';

type Handler = (msg: any) => Promise<void>;

/**
 * Обёртка над RabbitMQ: durable-очереди фоновой работы (master → брокер).
 * Источник истины — PostgreSQL; сообщение не является состоянием, воркеры идемпотентны.
 * Подключение с ретраем; при недоступности брокера API всё равно стартует.
 */
@Injectable()
export class RabbitMQService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('RabbitMQ');
  // тип соединения различается между версиями amqplib (Connection/ChannelModel) — берём из connect()
  private connection: Awaited<ReturnType<typeof amqp.connect>> | null = null;
  private channel: amqp.Channel | null = null;
  private readonly url: string;
  private readonly pending: Array<{ queue: string; handler: Handler; prefetch: number }> = [];
  private connecting = false;
  private closing = false;

  constructor(config: ConfigService) {
    this.url = config.getOrThrow<string>('RABBITMQ_URL');
  }

  async onModuleInit() {
    await this.connect();
  }

  private async connect(): Promise<void> {
    if (this.connecting) return;
    this.connecting = true;
    try {
      this.connection = await amqp.connect(this.url);
      this.channel = await this.connection.createChannel();
      await this.channel.assertQueue(Q_ECONOMICS, { durable: true });
      await this.channel.assertQueue(Q_AI_STANDUP, { durable: true });
      await this.channel.assertQueue(Q_ANALYTICS, { durable: true });
      await this.channel.assertQueue(Q_AI_ASSIST, { durable: true });
      await this.channel.assertQueue(Q_EMBEDDINGS, { durable: true });
      this.connection.on('close', () => {
        this.channel = null;
        this.connection = null;
        if (this.closing) return; // штатный шатдаун — не реконнектим (иначе висячий таймер в тестах)
        this.logger.warn('connection closed, reconnecting in 3s');
        setTimeout(() => this.connect(), 3000);
      });
      this.connection.on('error', () => undefined);
      // перерегистрируем консьюмеров
      for (const c of this.pending) await this.register(c.queue, c.handler, c.prefetch);
      this.logger.log('connected');
    } catch (err) {
      this.logger.warn(`connect failed: ${(err as Error).message}; retry in 3s`);
      setTimeout(() => this.connect(), 3000);
    } finally {
      this.connecting = false;
    }
  }

  async publish(queue: string, message: unknown): Promise<boolean> {
    if (!this.channel) {
      this.logger.warn(`publish skipped (no channel): ${queue}`);
      return false;
    }
    try {
      return this.channel.sendToQueue(queue, Buffer.from(JSON.stringify(message)), { persistent: true });
    } catch (err) {
      // канал мог закрыться (реконнект/шатдаун) — не роняем вызывающий код
      this.logger.warn(`publish failed on ${queue}: ${(err as Error).message}`);
      return false;
    }
  }

  /** Регистрирует консьюмера; переживает реконнекты. */
  async consume(queue: string, handler: Handler, prefetch = 4): Promise<void> {
    if (!this.pending.find((c) => c.queue === queue)) {
      this.pending.push({ queue, handler, prefetch });
    }
    if (this.channel) await this.register(queue, handler, prefetch);
  }

  private async register(queue: string, handler: Handler, prefetch: number) {
    if (!this.channel) return;
    await this.channel.prefetch(prefetch);
    await this.channel.consume(queue, async (msg) => {
      if (!msg || this.closing) return;
      try {
        const payload = JSON.parse(msg.content.toString());
        await handler(payload);
        this.safeAck(msg);
      } catch (err) {
        this.logger.error(`handler error on ${queue}: ${(err as Error).message}`);
        // requeue один раз: redelivered → отбрасываем, чтобы не зациклить
        this.safeNack(msg, !msg.fields.redelivered);
      }
    });
  }

  /**
   * ack/nack по закрывающемуся каналу кидают IllegalOperationError («Channel closing»);
   * при шатдауне/реконнекте брокер сам вернёт неподтверждённые сообщения — глушим ошибку,
   * чтобы не уронить процесс unhandled-rejection'ом (иначе падает весь e2e-suite на teardown).
   */
  private safeAck(msg: amqp.Message): void {
    if (this.closing || !this.channel) return;
    try { this.channel.ack(msg); } catch (e) { this.logger.warn(`ack skipped: ${(e as Error).message}`); }
  }

  private safeNack(msg: amqp.Message, requeue: boolean): void {
    if (this.closing || !this.channel) return;
    try { this.channel.nack(msg, false, requeue); } catch (e) { this.logger.warn(`nack skipped: ${(e as Error).message}`); }
  }

  async onModuleDestroy() {
    this.closing = true;
    try {
      await this.channel?.close();
      await this.connection?.close();
    } catch {
      /* ignore */
    }
  }
}

@Global()
@Module({
  providers: [RabbitMQService],
  exports: [RabbitMQService],
})
export class MessagingModule {}
