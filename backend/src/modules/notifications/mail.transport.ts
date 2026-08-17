import { Logger } from '@nestjs/common';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
}

/** Постоянная ошибка отправки: повторять бессмысленно (плохой адрес, отказ сервиса). */
export class MailPermanentError extends Error {}

export interface MailTransport {
  readonly name: string;
  send(msg: MailMessage): Promise<void>;
}

/**
 * Отправка через HTTPS-интерфейс Brevo.
 *
 * Именно HTTPS, а не SMTP: на нашем сервере хостер держит порты 25/587/465
 * закрытыми — проверено. HTTPS работает всегда и не зависит от их политики.
 * Сервис подписывает письма ключом нашего домена, поэтому почта доходит
 * до Gmail не в спам — при условии, что в DNS прописаны SPF, DKIM и DMARC.
 */
export class BrevoTransport implements MailTransport {
  readonly name = 'brevo';
  constructor(
    private readonly apiKey: string,
    private readonly from: { email: string; name: string },
  ) {}

  async send(msg: MailMessage): Promise<void> {
    const res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': this.apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: this.from,
        to: [{ email: msg.to }],
        subject: msg.subject,
        textContent: msg.text,
        ...(msg.html ? { htmlContent: msg.html } : {}),
      }),
    });
    if (res.ok) return;
    const body = await res.text().catch(() => '');
    // Отбрасываем только то, что относится к самому письму: неверный адрес или тело
    // запроса. Отказ по ключу и незарешённому IP (401/403) — общая чинимая беда,
    // и терять из-за неё письма нельзя: настроят доступ — очередь уйдёт сама.
    if (res.status === 400 || res.status === 422) {
      throw new MailPermanentError(`Brevo ${res.status}: ${body.slice(0, 200)}`);
    }
    throw new Error(`Brevo ${res.status}: ${body.slice(0, 200)}`);
  }
}

/**
 * Заглушка на время, пока ключ не выдан.
 *
 * Пишет письмо в журнал вместо отправки. Так вся цепочка — события, очередь,
 * настройки, шаблоны — работает и проверяется до того, как заведён аккаунт
 * в почтовом сервисе, и не копит необработанные задания.
 */
export class LogTransport implements MailTransport {
  readonly name = 'log';
  private readonly log = new Logger('Mail');
  async send(msg: MailMessage): Promise<void> {
    this.log.log(`[не отправлено, нет ключа] → ${msg.to} · ${msg.subject}`);
  }
}

/** Транспорт по переменным окружения. Без ключа — журнал, а не падение. */
export function createTransport(env: NodeJS.ProcessEnv): MailTransport {
  const key = env.BREVO_API_KEY?.trim();
  if (!key) return new LogTransport();
  return new BrevoTransport(key, {
    email: env.MAIL_FROM?.trim() || 'noreply@teamsmrt.com',
    name: env.MAIL_FROM_NAME?.trim() || 'TEAMCRM',
  });
}
