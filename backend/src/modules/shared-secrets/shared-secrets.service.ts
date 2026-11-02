import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { CheckKind, ENV_ONLY, isManaged, last4, MANAGED, plausibleKey, setActiveSecrets, sourceOf } from './secrets-registry';

interface Row {
  id: string; name: string; version: number; last4: string; status: string; note: string | null; expires_at: string | null;
  check_ok: boolean | null; check_message: string | null; checked_at: Date | null; created_at: Date; activated_at: Date | null;
  retired_at: Date | null; revoked_at: Date | null; revoke_reason: string | null; by_email: string | null;
}

/** Как часто каждый процесс API перечитывает реестр: замена ключа доходит до всех за это время. */
const REFRESH_MS = 30_000;

/**
 * Реестр общих ключей (§5.6). Значения — только внутри сервера: консоль получает
 * последние 4 символа, статус и результат проверки. Ни один метод не возвращает ключ.
 */
@Injectable()
export class SharedSecretsService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger('SharedSecrets');
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly db: DbService, private readonly crypto: IntegrationCryptoService) {}

  async onModuleInit(): Promise<void> {
    await this.refresh();
    if (process.env.NODE_ENV === 'test') return;
    this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Перечитать активные версии. Не расшифровалось — ключ пропускаем, действует .env. */
  async refresh(): Promise<void> {
    try {
      const rows = await this.db.many<{ name: string; value_enc: string }>(
        `SELECT name, value_enc FROM platform_secrets WHERE status='active' AND value_enc IS NOT NULL`);
      const next = new Map<string, string>();
      for (const r of rows) {
        try { next.set(r.name, this.crypto.decrypt(r.value_enc)); } catch { this.log.error(`ключ ${r.name}: не расшифровался — действует значение из .env`); }
      }
      setActiveSecrets(next);
    } catch (e) {
      // до миграции 0226 таблицы нет — работаем на .env, как раньше
      this.log.warn(`реестр ключей не прочитан: ${(e as Error).message}`);
    }
  }

  async list() {
    const rows = await this.db.many<Row>(
      `SELECT s.id::text, s.name, s.version, s.last4, s.status, s.note, to_char(s.expires_at, 'YYYY-MM-DD') AS expires_at,
              s.check_ok, s.check_message, s.checked_at, s.created_at, s.activated_at, s.retired_at, s.revoked_at, s.revoke_reason,
              a.email AS by_email
         FROM platform_secrets s LEFT JOIN pc_accounts a ON a.id = s.created_by
        ORDER BY s.name, s.version DESC`);
    const envTail = (name: string) => { const v = process.env[name]?.trim(); return v ? last4(v) : null; };
    return {
      managed: MANAGED.map((d) => ({
        ...d, source: sourceOf(d.name), envLast4: envTail(d.name),
        versions: rows.filter((r) => r.name === d.name),
      })),
      envOnly: ENV_ONLY.map((d) => ({ name: d.name, service: d.service, purpose: d.purpose, source: sourceOf(d.name), envLast4: envTail(d.name) })),
    };
  }

  /** Новая версия ключа — ещё не используется. Сразу проверяем, если провайдер позволяет. */
  async add(name: string, value: string, meta: { note: string | null; expiresAt: string | null; by: string }) {
    if (!isManaged(name)) throw AppException.validation('Этот ключ в консоли не заменяется');
    const v = value.trim();
    if (!plausibleKey(v)) throw AppException.validation('Не похоже на ключ: проверьте, что скопировали его целиком, без пробелов');
    const row = await this.db.withTransaction(async (c) => {
      // номер версии под замком: два добавления разом не получат один номер
      await c.query(`SELECT pg_advisory_xact_lock(hashtext('platform_secrets:' || $1::text))`, [name]);
      return (await c.query<{ id: string; version: number }>(
        `INSERT INTO platform_secrets (name, version, value_enc, last4, note, expires_at, created_by)
         VALUES ($1::varchar, coalesce((SELECT max(version) FROM platform_secrets WHERE name=$1::varchar), 0) + 1, $2, $3, $4, $5::date, $6)
         RETURNING id::text, version`,
        [name, this.crypto.encrypt(v), last4(v), meta.note, meta.expiresAt, meta.by])).rows[0];
    });
    const check = await this.runCheck(row.id, name, v);
    return { id: row.id, version: row.version, check };
  }

  async check(id: string) {
    const r = await this.one(id);
    if (!r.value_enc) throw AppException.conflict('Ключ отозван — проверять нечего');
    return this.runCheck(id, r.name, this.crypto.decrypt(r.value_enc));
  }

  /** Активировать: прежняя активная версия выводится (остаётся, её можно вернуть). */
  async activate(id: string, by: string) {
    const r = await this.one(id);
    if (r.status === 'revoked' || !r.value_enc) throw AppException.conflict('Отозванный ключ не вернуть — добавьте новый');
    if (r.status === 'active') return { ok: true };
    await this.db.withTransaction(async (c) => {
      await c.query(`UPDATE platform_secrets SET status='retired', retired_at=now() WHERE name=$1 AND status='active'`, [r.name]);
      await c.query(`UPDATE platform_secrets SET status='active', activated_at=now(), activated_by=$2, retired_at=NULL WHERE id=$1`, [id, by]);
    });
    await this.refresh();
    return { ok: true, name: r.name };
  }

  /**
   * Отозвать: значение стирается. Если отозвали активную — действует .env (если там есть
   * значение): консоль предупреждает об этом до нажатия.
   */
  async revoke(id: string, by: string, reason: string) {
    const r = await this.one(id);
    if (r.status === 'revoked') return { ok: true };
    await this.db.query(
      `UPDATE platform_secrets SET status='revoked', value_enc=NULL, revoked_at=now(), revoked_by=$2, revoke_reason=$3 WHERE id=$1`,
      [id, by, reason]);
    await this.refresh();
    return { ok: true, name: r.name, wasActive: r.status === 'active' };
  }

  private async one(id: string) {
    const r = await this.db.one<{ name: string; status: string; value_enc: string | null }>(
      `SELECT name, status, value_enc FROM platform_secrets WHERE id=$1`, [id]);
    if (!r) throw AppException.notFound('Ключ не найден');
    return r;
  }

  private async runCheck(id: string, name: string, value: string) {
    const kind = MANAGED.find((d) => d.name === name)?.check ?? 'none';
    const res = await probe(kind, value);
    await this.db.query(
      `UPDATE platform_secrets SET check_ok=$2, check_message=$3, checked_at=now() WHERE id=$1`, [id, res.ok, res.message.slice(0, 300)]);
    return res;
  }
}

/**
 * Проверка ключа у провайдера — запрос списка моделей или данных о ключе (бесплатно).
 * Текст ответа провайдера не сохраняем: в нём бывает часть ключа.
 */
async function probe(kind: CheckKind, key: string): Promise<{ ok: boolean | null; message: string }> {
  const req: Record<Exclude<CheckKind, 'none'>, { url: string; headers: Record<string, string> }> = {
    openai: { url: 'https://api.openai.com/v1/models', headers: { Authorization: `Bearer ${key}` } },
    kimi: { url: 'https://api.moonshot.ai/v1/models', headers: { Authorization: `Bearer ${key}` } },
    openrouter: { url: 'https://openrouter.ai/api/v1/key', headers: { Authorization: `Bearer ${key}` } },
    anthropic: { url: 'https://api.anthropic.com/v1/models', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } },
  };
  if (kind === 'none') return { ok: null, message: 'Проверка у этого провайдера не поддерживается — проверьте работу после активации' };
  try {
    const res = await fetch(req[kind].url, { headers: req[kind].headers, signal: AbortSignal.timeout(8000) });
    if (res.ok) return { ok: true, message: 'Провайдер принял ключ' };
    if (res.status === 401 || res.status === 403) return { ok: false, message: `Провайдер отклонил ключ (${res.status})` };
    return { ok: false, message: `Провайдер ответил ${res.status} — попробуйте проверить позже` };
  } catch (e) {
    return { ok: false, message: (e as Error).name === 'TimeoutError' ? 'Провайдер не ответил за 8 секунд' : 'Нет связи с провайдером' };
  }
}
