import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { DbService } from '../../database/db.service';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import {
  exchangeCode, fetchUserInfo, GOOGLE_AUTH_URL, GoogleApiError, GoogleService, grantedServices,
  refreshAccessToken, revokeToken, scopesFor,
} from './google-api';

export interface GoogleAccountRow {
  id: string; tenant_id: string; user_id: string; google_sub: string; email: string;
  display_name: string | null; access_token_enc: string | null; refresh_token_enc: string | null;
  access_token_expires_at: Date | null; scopes: string[]; status: 'active' | 'attention';
  last_error: string | null; connected_at: Date;
}

/** Обновляем токен заранее: запрос к Google не должен упасть на последних секундах жизни токена. */
const EARLY_REFRESH_MS = 2 * 60_000;
const STATE_TTL_MIN = 10;

/**
 * Подключение Google человека по OAuth (#1565, §28–35 ТЗ).
 *
 * Refresh-токен лежит только шифрованным и наружу не выходит никогда; браузер получает
 * лишь короткий access-токен — для окна выбора файлов Google (Picker), которому он нужен.
 */
@Injectable()
export class GoogleAuthService {
  private readonly log = new Logger('GoogleAuth');
  /** Один refresh на аккаунт за раз: параллельные запросы ждут его, а не меняют токен наперегонки. */
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly db: DbService,
    private readonly crypto: IntegrationCryptoService,
    private readonly config: ConfigService,
  ) {}

  private cfg() {
    // Клиент может быть тем же, что и у входа через Google (GOOGLE_CLIENT_ID) — это один веб-клиент
    const clientId = String(this.config.get('GOOGLE_OAUTH_CLIENT_ID') || this.config.get('GOOGLE_CLIENT_ID') || '').trim();
    const clientSecret = String(this.config.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '').trim();
    const base = String(this.config.get('APP_BASE_URL') || 'https://app.qevo.one').replace(/\/+$/, '');
    const redirectUri = String(this.config.get('GOOGLE_OAUTH_REDIRECT_URI') || `${base}/api/integrations/google/callback`).trim();
    return { clientId, clientSecret, redirectUri, base };
  }

  configured(): boolean {
    const c = this.cfg();
    return !!(c.clientId && c.clientSecret);
  }

  /** Для окна выбора файлов: ключ и номер проекта Google не секретны, но без них Picker не откроется. */
  pickerConfig() {
    const apiKey = String(this.config.get('GOOGLE_PICKER_API_KEY') ?? '').trim();
    const appId = String(this.config.get('GOOGLE_PROJECT_NUMBER') ?? '').trim();
    return apiKey && appId ? { apiKey, appId, clientId: this.cfg().clientId } : null;
  }

  account(tenantId: string, userId: string): Promise<GoogleAccountRow | null> {
    return this.db.one<GoogleAccountRow>(
      `SELECT * FROM google_accounts WHERE tenant_id=$1 AND user_id=$2`, [tenantId, userId],
    );
  }

  async status(tenantId: string, userId: string) {
    const a = await this.account(tenantId, userId);
    const services = grantedServices(a?.scopes ?? []);
    return {
      configured: this.configured(),
      picker: this.pickerConfig(),
      account: a ? {
        email: a.email,
        name: a.display_name,
        status: a.status,
        lastError: a.status === 'attention' ? a.last_error : null,
        connectedAt: a.connected_at,
        drive: services.drive,
        calendar: services.calendar,
      } : null,
    };
  }

  /**
   * Адрес экрана согласия Google. Разрешения просим по частям (§16): Диск — когда
   * подключают Диск, Календарь — когда Календарь; include_granted_scopes сохраняет уже выданное.
   */
  async connectUrl(tenantId: string, userId: string, service: GoogleService, returnTo?: string): Promise<{ url: string }> {
    const c = this.cfg();
    if (!this.configured()) throw AppException.validation('Интеграция с Google ещё не настроена на сервере');
    const state = randomBytes(24).toString('hex');
    // возвращаем только на свои страницы: иначе ссылкой «подключить Google» уводили бы на чужой сайт
    const safeReturn = returnTo && /^\/[a-z0-9/_-]*$/i.test(returnTo) ? returnTo.slice(0, 200) : null;
    await this.db.query(`DELETE FROM google_oauth_states WHERE expires_at < now()`);
    await this.db.query(
      `INSERT INTO google_oauth_states (state, tenant_id, user_id, service, return_to, expires_at)
       VALUES ($1,$2,$3,$4,$5, now() + make_interval(mins => $6))`,
      [state, tenantId, userId, service, safeReturn, STATE_TTL_MIN],
    );
    const existing = await this.account(tenantId, userId);
    const u = new URL(GOOGLE_AUTH_URL);
    u.searchParams.set('client_id', c.clientId);
    u.searchParams.set('redirect_uri', c.redirectUri);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('scope', scopesFor(service).join(' '));
    u.searchParams.set('access_type', 'offline');
    u.searchParams.set('include_granted_scopes', 'true');
    // consent — чтобы Google точно выдал refresh-токен; без него доступ умрёт через час
    u.searchParams.set('prompt', 'consent');
    u.searchParams.set('state', state);
    if (existing?.email) u.searchParams.set('login_hint', existing.email);
    return { url: u.toString() };
  }

  /**
   * Возврат с экрана согласия. Отвечаем всегда редиректом на страницу настроек —
   * человек пришёл браузером, JSON ему не показать.
   */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<string> {
    const c = this.cfg();
    const back = (path: string | null, result: string) => `${c.base}${path || '/settings/google'}?google=${result}`;
    if (!q.state) return back(null, 'error');
    const st = await this.db.one<{ tenant_id: string; user_id: string; return_to: string | null }>(
      `DELETE FROM google_oauth_states WHERE state=$1 AND expires_at > now() RETURNING tenant_id, user_id, return_to`,
      [q.state],
    );
    // state одноразовый и с нашей стороны: чужой или протухший — не принимаем (§30)
    if (!st) return back(null, 'expired');
    if (q.error || !q.code) return back(st.return_to, q.error === 'access_denied' ? 'denied' : 'error');
    try {
      const tokens = await exchangeCode(q.code, c);
      const info = await fetchUserInfo(tokens.access_token);
      const scopes = (tokens.scope ?? '').split(/\s+/).filter(Boolean);
      const prev = await this.account(st.tenant_id, st.user_id);
      if (prev && prev.google_sub !== info.sub) {
        // другой Google у того же человека — старый отзываем, чтобы не остался висеть доступ
        const old = prev.refresh_token_enc ? this.crypto.decrypt(prev.refresh_token_enc) : null;
        if (old) await revokeToken(old);
        await this.db.query(`DELETE FROM google_calendar_events WHERE user_id=$1`, [st.user_id]);
        await this.db.query(`UPDATE google_calendar_settings SET sync_token=NULL, calendar_id='primary', calendar_title=NULL WHERE user_id=$1`, [st.user_id]);
      }
      // refresh-токен Google выдаёт не каждый раз — если не выдал, держим прежний
      const refreshEnc = tokens.refresh_token ? this.crypto.encrypt(tokens.refresh_token)
        : prev && prev.google_sub === info.sub ? prev.refresh_token_enc : null;
      if (!refreshEnc) return back(st.return_to, 'error');
      await this.db.query(
        `INSERT INTO google_accounts (tenant_id, user_id, google_sub, email, display_name,
            access_token_enc, refresh_token_enc, access_token_expires_at, scopes, status, last_error, connected_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7, now() + make_interval(secs => $8), $9, 'active', NULL, now(), now())
         ON CONFLICT (user_id) DO UPDATE SET
            tenant_id=EXCLUDED.tenant_id, google_sub=EXCLUDED.google_sub, email=EXCLUDED.email,
            display_name=EXCLUDED.display_name, access_token_enc=EXCLUDED.access_token_enc,
            refresh_token_enc=EXCLUDED.refresh_token_enc, access_token_expires_at=EXCLUDED.access_token_expires_at,
            scopes=EXCLUDED.scopes, status='active', last_error=NULL, updated_at=now()`,
        [st.tenant_id, st.user_id, info.sub, info.email, info.name ?? null,
          this.crypto.encrypt(tokens.access_token), refreshEnc, tokens.expires_in || 3600, scopes],
      );
      if (grantedServices(scopes).calendar) {
        await this.db.query(
          `INSERT INTO google_calendar_settings (user_id, tenant_id) VALUES ($1,$2) ON CONFLICT (user_id) DO NOTHING`,
          [st.user_id, st.tenant_id],
        );
      }
      await this.audit(st.tenant_id, st.user_id, 'google.connected', { email: info.email, scopes });
      return back(st.return_to, 'connected');
    } catch (e) {
      this.log.warn(`подключение не удалось: ${(e as Error).message}`);
      return back(st.return_to, 'error');
    }
  }

  /** Отключение (§35): отзываем доступ в Google и стираем токены; привязанные файлы остаются ссылками. */
  async disconnect(tenantId: string, userId: string) {
    const a = await this.account(tenantId, userId);
    if (!a) return { disconnected: true };
    const refresh = a.refresh_token_enc ? this.safeDecrypt(a.refresh_token_enc) : null;
    if (refresh) await revokeToken(refresh);
    await this.db.query(`DELETE FROM google_calendar_events WHERE user_id=$1`, [userId]);
    await this.db.query(`DELETE FROM google_calendar_settings WHERE user_id=$1`, [userId]);
    await this.db.query(`DELETE FROM calendar_links WHERE user_id=$1 AND kind='google'`, [userId]);
    await this.db.query(`DELETE FROM google_accounts WHERE id=$1`, [a.id]);
    await this.audit(tenantId, userId, 'google.disconnected', { email: a.email });
    return { disconnected: true };
  }

  /**
   * Живой access-токен аккаунта. Протух — обновляем refresh-токеном; Google отказал
   * (доступ отозван) — помечаем аккаунт «нужно переподключить» и говорим это человеку.
   */
  async accessToken(a: GoogleAccountRow): Promise<string> {
    if (a.status === 'attention') throw this.reconnectError();
    const fresh = a.access_token_enc && a.access_token_expires_at
      && new Date(a.access_token_expires_at).getTime() - Date.now() > EARLY_REFRESH_MS;
    if (fresh) {
      const t = this.safeDecrypt(a.access_token_enc!);
      if (t) return t;
    }
    const running = this.refreshing.get(a.id);
    if (running) return running;
    const p = this.refresh(a).finally(() => this.refreshing.delete(a.id));
    this.refreshing.set(a.id, p);
    return p;
  }

  private async refresh(a: GoogleAccountRow): Promise<string> {
    const refresh = a.refresh_token_enc ? this.safeDecrypt(a.refresh_token_enc) : null;
    if (!refresh) { await this.markAttention(a.id, 'Нет ключа обновления'); throw this.reconnectError(); }
    try {
      const t = await refreshAccessToken(refresh, this.cfg());
      await this.db.query(
        `UPDATE google_accounts SET access_token_enc=$2, access_token_expires_at=now() + make_interval(secs => $3), updated_at=now()
          WHERE id=$1`,
        [a.id, this.crypto.encrypt(t.access_token), t.expires_in || 3600],
      );
      return t.access_token;
    } catch (e) {
      if (e instanceof GoogleApiError && e.kind === 'reconnect') {
        await this.markAttention(a.id, 'Google отозвал доступ');
        throw this.reconnectError();
      }
      throw e;
    }
  }

  /** Токен аккаунта человека; нет подключения или нужного разрешения — понятная ошибка. */
  async tokenFor(tenantId: string, userId: string, need: 'drive' | 'calendar'): Promise<{ account: GoogleAccountRow; token: string }> {
    const a = await this.account(tenantId, userId);
    if (!a) throw AppException.validation('Подключите Google в «Настройки → Google»');
    if (!grantedServices(a.scopes)[need]) {
      throw AppException.validation(need === 'drive'
        ? 'Нужно разрешить доступ к Google Диску: «Настройки → Google → Подключить Диск»'
        : 'Нужно разрешить доступ к Google Календарю: «Настройки → Google → Подключить Календарь»');
    }
    return { account: a, token: await this.accessToken(a) };
  }

  /** Короткий токен для окна выбора файлов в браузере (§39). Refresh-токен не отдаём никогда. */
  async pickerToken(tenantId: string, userId: string) {
    const { token, account } = await this.tokenFor(tenantId, userId, 'drive');
    const left = account.access_token_expires_at ? Math.max(60, Math.round((new Date(account.access_token_expires_at).getTime() - Date.now()) / 1000)) : 3000;
    return { accessToken: token, expiresIn: left };
  }

  async markAttention(accountId: string, why: string) {
    await this.db.query(
      `UPDATE google_accounts SET status='attention', last_error=$2, access_token_enc=NULL, updated_at=now() WHERE id=$1`,
      [accountId, why.slice(0, 300)],
    );
  }

  private reconnectError() {
    return AppException.validation('Доступ к Google нужно подключить заново: «Настройки → Google»');
  }

  private safeDecrypt(v: string): string | null {
    try { return this.crypto.decrypt(v); } catch { return null; }
  }

  /** Журнал действий (§94): кто, что и когда. Токены сюда не пишем. */
  async audit(tenantId: string, userId: string, action: string, meta: Record<string, unknown>) {
    this.log.log(`${action} tenant=${tenantId} user=${userId} ${JSON.stringify(meta).slice(0, 300)}`);
  }
}
