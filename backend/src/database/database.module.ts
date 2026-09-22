import { Global, Module } from '@nestjs/common';
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
          /*
            В тестах простаивающее соединение закрываем через секунду: шестьдесят e2e-наборов,
            каждый со своим приложением, иначе копили соединения до истечения таймаута, и
            Postgres в CI отвечал «sorry, too many clients already». Жёстко закрывать пул при
            остановке нельзя — фоновые задачи (ответ ИИ в поддержке) ещё бегут и падали бы
            на «pool after calling end».
          */
          idleTimeoutMillis: process.env.NODE_ENV === 'test' ? 1_000 : 30_000,
          connectionTimeoutMillis: 5_000,
        });
        return pool;
      },
    },
    DbService,
  ],
  exports: [PG_POOL, DbService],
})
export class DatabaseModule {}
