import { Global, Inject, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { DbService } from './db.service';
import { PG_POOL } from './database.tokens';

export { PG_POOL };

@Global()
@Module({
  providers: [
    {
      provide: PG_POOL,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const pool = new Pool({
          connectionString: config.getOrThrow<string>('DATABASE_URL'),
          max: 10,
          idleTimeoutMillis: 30_000,
          connectionTimeoutMillis: 5_000,
        });
        return pool;
      },
    },
    DbService,
  ],
  exports: [PG_POOL, DbService],
})
export class DatabaseModule implements OnModuleDestroy {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /*
    Закрыть пул вместе с приложением.

    Без этого каждый e2e-набор (их шестьдесят, каждый поднимает своё приложение)
    оставлял до десяти соединений висеть до idle-таймаута, и на быстром прогоне
    Postgres в CI отвечал «sorry, too many clients already» на середине списка.
  */
  async onModuleDestroy(): Promise<void> {
    await this.pool.end().catch(() => undefined);
  }
}
