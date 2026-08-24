/**
 * Forward-only миграционный раннер.
 * Применяет migrations/*.sql в лексикографическом порядке, каждую — в транзакции,
 * фиксирует применённые версии в schema_migrations. Откат — встречной миграцией.
 *
 * Запуск: npm run migrate   (использует DATABASE_URL из окружения)
 */
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { Pool } from 'pg';

const MIGRATIONS_DIR = join(__dirname, '..', '..', 'migrations');

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');

  const pool = new Pool({ connectionString: url });
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);

    const applied = new Set(
      (await pool.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );

    const files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort();

    let count = 0;
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`= skip ${version} (already applied)`);
        continue;
      }
      const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
      const client = await pool.connect();
      /**
       * Сообщения самой миграции (RAISE NOTICE) выводим в лог деплоя.
       *
       * Раньше они пропадали: pg отдаёт их событием, которое никто не слушал. Из-за
       * этого разовая правка данных отчитывалась «в никуда» — миграция 0042 честно
       * посчитала, сколько имён файлов починила, и сказала это в пустоту. Теперь любая
       * миграция может рассказать о результате, и он виден в логе выкатки.
       */
      const onNotice = (n: { message?: string }) => {
        if (n.message) console.log(`  ${version}: ${n.message}`);
      };
      client.on('notice', onNotice);
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
        console.log(`+ applied ${version}`);
        count++;
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`! failed ${version}:`, (err as Error).message);
        throw err;
      } finally {
        // Соединение возвращается в пул и достанется следующей миграции — слушатель
        // обязан уйти вместе с ней, иначе чужие сообщения подпишутся не тем номером.
        client.removeListener('notice', onNotice);
        client.release();
      }
    }
    console.log(`done: ${count} migration(s) applied, ${files.length} total.`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
