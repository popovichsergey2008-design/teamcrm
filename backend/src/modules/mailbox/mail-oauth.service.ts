import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { verify } from './mail-client';
import {
  authorizeUrl, clientFor, exchangeCode, fetchEmail, isOAuthProvider, MailOAuthError, MailOAuthState, OAUTH_MAIL_PROVIDERS,
  OAUTH_SPECS, OAuthClient, OAuthMailProvider, refreshToken, returnUrl, signState, verifyState,
} from './mail-oauth';
import { AccountRow, MailboxRepository } from './mailbox.repository';

/** Обновляем токен заранее: забор не должен упасть на последних секундах его жизни. */
const EARLY_REFRESH_MS = 2 * 60_000;

/**
 * Почта кнопкой (#4893, п. 2): экран согласия почтовика → возврат с кодом → токены
 * шифрованными в mail_accounts. Дальше ящик живёт как любой другой, только вход по токену.
 *
 * Refresh-токен наружу не выходит никогда; access-токен обновляется здесь же перед
 * каждым обращением к почте, по одному обновлению на ящик за раз.
 */
@Injectable()
export class MailOAuthService {
  private readonly log = new Logger('MailOAuth');
  private readonly refreshing = new Map<string, Promise<string>>();
  private readonly stateSecret: string;

  constructor(
    private readonly repo: MailboxRepository,
    private readonly crypto: IntegrationCryptoService,
    private readonly config: ConfigService,
  ) {
    // свой ключ подписи, производный от общего секрета: тот же, что у шифрования, использовать напрямую не стоит
    const base = String(config.get('INTEGRATION_ENC_KEY') || config.get('JWT_ACCESS_SECRET') || '');
    this.stateSecret = createHash('sha256').update(`mail-oauth-state:${base}`).digest('hex');
  }

  private base(): string {
    return String(this.config.get('APP_BASE_URL') || 'https://app.qevo.one').replace(/\/+$/, '');
  }

  /** Один адрес возврата на всех трёх почтовиков: кто это, говорит подписанный state. */
  redirectUri(): string {
    return String(this.config.get('MAIL_OAUTH_REDIRECT_URI') || `${this.base()}/api/mailbox/oauth/callback`).trim();
  }

  private client(p: OAuthMailProvider): OAuthClient | null {
    return clientFor(p, (k) => this.config.get(k), this.redirectUri());
  }

  /** Какие кнопки рабочие. Ненастроенную кнопку экран всё равно показывает — и честно объясняет. */
  providers() {
    return OAUTH_MAIL_PROVIDERS.map((id) => ({ id, title: OAUTH_SPECS[id].title, configured: !!this.client(id) }));
  }

  start(tenantId: string, userId: string, i: { provider: string; resume?: string | null; from?: string | null }): { url: string } {
    if (!isOAuthProvider(i.provider)) throw AppException.validation('Неизвестный почтовик');
    const c = this.client(i.provider);
    if (!c) {
      throw AppException.validation(`Вход через ${OAUTH_SPECS[i.provider].title} ещё не включён администратором. Подключите ящик через «Другая почта».`);
    }
    const state = signState({
      p: i.provider, t: String(tenantId), u: String(userId), f: i.from === 'settings' ? 'settings' : 'bot',
      ...(i.resume?.trim() ? { r: i.resume } : {}),
    }, this.stateSecret);
    return { url: authorizeUrl(i.provider, c, state) };
  }

  /**
   * Возврат с экрана согласия. Отвечаем всегда редиректом: человек пришёл браузером.
   * accountId — чтобы контроллер сразу забрал первые письма для «214 писем · важно 6».
   */
  async callback(q: { code?: string; state?: string; error?: string }): Promise<{ redirect: string; accountId?: string }> {
    const st = verifyState(q.state, this.stateSecret);
    const fail = (s: MailOAuthState | null, error: string) => ({ redirect: returnUrl(this.base(), s, { ok: false, error }) });
    if (!st) return fail(null, 'Ссылка входа устарела — нажмите кнопку подключения ещё раз');
    if (q.error || !q.code) {
      return fail(st, q.error === 'access_denied' ? 'Доступ к почте не разрешён' : 'Почтовик не подтвердил вход');
    }
    const c = this.client(st.p);
    if (!c) return fail(st, 'Вход через этого почтовика выключен');
    const spec = OAUTH_SPECS[st.p];
    try {
      const tokens = await exchangeCode(st.p, c, q.code);
      const email = await fetchEmail(st.p, tokens.access_token);
      const prev = (await this.repo.accounts(st.t, st.u)).find((a) => a.email === email);
      // Google выдаёт refresh-токен не на каждый вход — держим прежний того же ящика
      const refresh = tokens.refresh_token
        ?? (prev?.auth_kind === 'oauth' && prev.oauth_provider === st.p ? this.safeDecrypt(prev.secret_enc) : null);
      if (!refresh) return fail(st, 'Почтовик не выдал постоянный доступ — подключите ещё раз');
      // вход проверяем сразу: у Яндекса IMAP бывает выключен в настройках ящика, и узнать это лучше сейчас
      await verify({
        email, username: email, password: '', accessToken: tokens.access_token,
        imapHost: spec.imap[0], imapPort: spec.imap[1], smtpHost: spec.smtp[0], smtpPort: spec.smtp[1],
      });
      const row = await this.repo.upsertOAuthAccount({
        tenantId: st.t, userId: st.u, provider: spec.mailProvider, oauthProvider: st.p, email,
        imapHost: spec.imap[0], imapPort: spec.imap[1], smtpHost: spec.smtp[0], smtpPort: spec.smtp[1],
        refreshEnc: this.crypto.encrypt(refresh), accessEnc: this.crypto.encrypt(tokens.access_token),
        expiresIn: Number(tokens.expires_in) || 3600,
      });
      this.log.log(`ящик подключён кнопкой: tenant=${st.t} user=${st.u} provider=${st.p}`);
      return { redirect: returnUrl(this.base(), st, { ok: true }), accountId: String(row.id) };
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`вход ${st.p} не удался: ${msg}`);
      return fail(st, e instanceof MailOAuthError ? 'Почтовик не подтвердил вход — попробуйте ещё раз' : msg);
    }
  }

  /** Живой access-токен ящика: протух — обновляем; почтовик отказал — ящик «нужно подключить заново». */
  async accessToken(a: AccountRow): Promise<string> {
    const fresh = a.oauth_access_enc && a.oauth_expires_at
      && new Date(a.oauth_expires_at).getTime() - Date.now() > EARLY_REFRESH_MS;
    if (fresh) {
      const t = this.safeDecrypt(a.oauth_access_enc!);
      if (t) return t;
    }
    const id = String(a.id);
    const running = this.refreshing.get(id);
    if (running) return running;
    const p = this.refresh(a).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, p);
    return p;
  }

  private async refresh(a: AccountRow): Promise<string> {
    const reconnect = 'Доступ к почте отозван — подключите ящик заново в «Настройки → Почта»';
    const provider = a.oauth_provider;
    if (!isOAuthProvider(provider)) throw new Error('Неизвестный почтовик у ящика');
    const c = this.client(provider);
    if (!c) throw new Error(`Вход через ${OAUTH_SPECS[provider].title} выключен на сервере`);
    const refresh = this.safeDecrypt(a.secret_enc);
    if (!refresh) { await this.repo.markOAuthBroken(String(a.id), reconnect); throw new Error(reconnect); }
    try {
      const t = await refreshToken(provider, c, refresh);
      await this.repo.saveAccessToken(
        String(a.id), this.crypto.encrypt(t.access_token), Number(t.expires_in) || 3600,
        t.refresh_token && t.refresh_token !== refresh ? this.crypto.encrypt(t.refresh_token) : null,
      );
      return t.access_token;
    } catch (e) {
      if (e instanceof MailOAuthError && e.reconnect) {
        await this.repo.markOAuthBroken(String(a.id), reconnect);
        throw new Error(reconnect);
      }
      throw e;
    }
  }

  private safeDecrypt(v: string): string | null {
    try { return this.crypto.decrypt(v); } catch { return null; }
  }
}
