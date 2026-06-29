import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { connect } from 'net';
import { DbService } from '../../database/db.service';

type Check = 'ok' | 'down';

export interface HealthReport {
  status: 'ok' | 'degraded';
  checks: { postgres: Check; redis: Check; rabbitmq: Check };
  schemaVersion: string | null;
}

@Injectable()
export class HealthService {
  constructor(
    private readonly db: DbService,
    private readonly config: ConfigService,
  ) {}

  async check(): Promise<HealthReport> {
    const [postgres, schemaVersion] = await this.checkPostgres();
    const redis = await this.checkRedis();
    const rabbitmq = await this.checkRabbit();
    const status =
      postgres === 'ok' && redis === 'ok' && rabbitmq === 'ok' ? 'ok' : 'degraded';
    return { status, checks: { postgres, redis, rabbitmq }, schemaVersion };
  }

  private async checkPostgres(): Promise<[Check, string | null]> {
    try {
      const row = await this.db.one<{ version: string }>(
        `SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1`,
      );
      return ['ok', row?.version ?? null];
    } catch {
      return ['down', null];
    }
  }

  private async checkRedis(): Promise<Check> {
    const client = new Redis(this.config.getOrThrow<string>('REDIS_URL'), {
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
    });
    try {
      await client.connect();
      const pong = await client.ping();
      return pong === 'PONG' ? 'ok' : 'down';
    } catch {
      return 'down';
    } finally {
      client.disconnect();
    }
  }

  private checkRabbit(): Promise<Check> {
    const url = new URL(this.config.getOrThrow<string>('RABBITMQ_URL'));
    const host = url.hostname;
    const port = Number(url.port || 5672);
    return new Promise<Check>((resolve) => {
      const socket = connect({ host, port, timeout: 2000 });
      const done = (result: Check) => {
        socket.destroy();
        resolve(result);
      };
      socket.once('connect', () => done('ok'));
      socket.once('error', () => done('down'));
      socket.once('timeout', () => done('down'));
    });
  }
}
