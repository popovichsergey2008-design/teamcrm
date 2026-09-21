import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createSign } from 'node:crypto';

/**
 * Отправка push через Firebase Cloud Messaging (HTTP v1) — обеим платформам.
 *
 * Без SDK: сервисный аккаунт Google — это RSA-ключ, из него подписывается JWT, JWT
 * меняется на access-токен, токен идёт в заголовок. Сорок строк вместо пакета на
 * десятки мегабайт. Ключ приходит переменной FCM_SERVICE_ACCOUNT_JSON (base64 или
 * JSON); её нет — push выключен, и это видно в логе один раз при старте.
 */
interface ServiceAccount { project_id: string; client_email: string; private_key: string }

export type PushOutcome = 'sent' | 'invalid_token' | 'error' | 'disabled';

@Injectable()
export class FcmSender {
  private readonly log = new Logger('FCM');
  private readonly account: ServiceAccount | null;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(config: ConfigService) {
    this.account = this.parse(config.get<string>('FCM_SERVICE_ACCOUNT_JSON'));
    this.log.log(this.account ? `push включён: проект ${this.account.project_id}` : 'push выключен: нет FCM_SERVICE_ACCOUNT_JSON');
  }

  get enabled(): boolean { return !!this.account; }

  private parse(raw?: string): ServiceAccount | null {
    if (!raw) return null;
    try {
      const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
      const j = JSON.parse(text);
      if (!j.project_id || !j.client_email || !j.private_key) return null;
      return { project_id: j.project_id, client_email: j.client_email, private_key: j.private_key };
    } catch { return null; }
  }

  /** OAuth2 по сервисному аккаунту: JWT RS256 → access-токен на час (кэшируем с запасом). */
  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now() + 60_000) return this.token.value;
    const acc = this.account!;
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: acc.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(acc.private_key).toString('base64url');
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
    });
    if (!res.ok) throw new Error(`oauth ${res.status}`);
    const j = (await res.json()) as { access_token: string; expires_in: number };
    this.token = { value: j.access_token, expiresAt: Date.now() + j.expires_in * 1000 };
    return j.access_token;
  }

  /**
   * Одно уведомление одному устройству.
   *
   * `data` — то, что читает приложение (куда вести, номер строки ящика);
   * `notification` — то, что рисует ОС, когда приложение закрыто. Высокий приоритет:
   * иначе Android доставит «когда-нибудь», а человек ждёт ответ поддержки сейчас.
   */
  async send(token: string, msg: { title: string; body: string; data: Record<string, string>; badge?: number }): Promise<PushOutcome> {
    if (!this.account) return 'disabled';
    try {
      const res = await fetch(`https://fcm.googleapis.com/v1/projects/${this.account.project_id}/messages:send`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${await this.accessToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            token,
            notification: { title: msg.title, body: msg.body },
            data: msg.data,
            android: { priority: 'high', notification: { channel_id: 'anthill', sound: 'default' } },
            apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default', badge: msg.badge ?? undefined } } },
          },
        }),
      });
      if (res.ok) return 'sent';
      const text = await res.text();
      // UNREGISTERED / NOT_FOUND — токен мёртв, устройство удалило приложение или сменило токен
      if (res.status === 404 || /UNREGISTERED|NOT_FOUND|InvalidRegistration/.test(text)) return 'invalid_token';
      this.log.warn(`fcm ${res.status}: ${text.slice(0, 200)}`);
      return 'error';
    } catch (e) {
      this.log.warn(`fcm: ${(e as Error).message}`);
      return 'error';
    }
  }
}