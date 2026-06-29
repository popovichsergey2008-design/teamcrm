import { INestApplicationContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import { ServerOptions } from 'socket.io';

/**
 * Socket.io c Redis-адаптером (master → горизонтальное масштабирование realtime).
 * Presence и pub/sub fan-out идут через Redis.
 */
export class RedisIoAdapter extends IoAdapter {
  private adapterConstructor!: ReturnType<typeof createAdapter>;
  private readonly corsOrigin: string | string[];

  constructor(app: INestApplicationContext) {
    super(app);
    const config = app.get(ConfigService);
    // CORS_ORIGIN может быть списком через запятую (несколько origin: :80, :8080, dev)
    const raw = config.getOrThrow<string>('CORS_ORIGIN');
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    this.corsOrigin = list.length > 1 ? list : list[0];
    const url = config.getOrThrow<string>('REDIS_URL');
    const pubClient = new Redis(url);
    const subClient = pubClient.duplicate();
    this.adapterConstructor = createAdapter(pubClient, subClient);
  }

  createIOServer(port: number, options?: ServerOptions): any {
    const server = super.createIOServer(port, {
      ...options,
      cors: { origin: this.corsOrigin, credentials: true },
    });
    server.adapter(this.adapterConstructor);
    return server;
  }
}
