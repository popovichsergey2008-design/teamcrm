import { Logger } from '@nestjs/common';
import nodemailer from 'nodemailer';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string | null;
  /** Вложения: [{name, content}] с содержимым в base64 — приглашение возит с собой .ics. */
  attachments?: { name: string; content: string }[] | null;
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
        ...(msg.attachments?.length ? { attachment: msg.attachments } : {}),
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
    const files = msg.attachments?.length ? ` (+${msg.attachments.length} вложение)` : '';
    this.log.log(`[не отправлено, нет ключа] → ${msg.to} · ${msg.subject}${files}`);
  }
}

/**
 * Свой почтовый сервер (#4793, 05.11): после переезда на российский сервер порт 587
 * открыт, и письма уходят через mail.qevo.one (/opt/qevo-mail) с подписью DKIM.
 * Отказ сервера по адресу (5xx) — постоянная ошибка, повторять бессмысленно.
 */
export class SmtpTransport implements MailTransport {
  readonly name = 'smtp';
  private readonly t: nodemailer.Transporter;
  constructor(
    opts: { host: string; port: number; user?: string; pass?: string },
    private readonly from: { email: string; name: string },
  ) {
    this.t = nodemailer.createTransport({
      host: opts.host, port: opts.port, secure: opts.port === 465,
      ...(opts.user ? { auth: { user: opts.user, pass: opts.pass ?? '' } } : {}),
      // внутри сети сервер отвечает по имени контейнера, а сертификат выписан на mail.qevo.one
      tls: { servername: 'mail.qevo.one' },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }

  async send(msg: MailMessage): Promise<void> {
    try {
      await this.t.sendMail({
        from: { address: this.from.email, name: this.from.name },
        to: msg.to,
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
        ...(msg.attachments?.length
          ? { attachments: msg.attachments.map((a) => ({ filename: a.name, content: Buffer.from(a.content, 'base64') })) }
          : {}),
      });
    } catch (e) {
      const code = Number((e as { responseCode?: number }).responseCode);
      if (code >= 500 && code < 600 && code !== 535 && code !== 530) {
        throw new MailPermanentError(`SMTP ${code}: ${(e as Error).message.slice(0, 200)}`);
      }
      throw e;
    }
  }
}

/**
 * Свой сервер — первым, Brevo — запасным: сервер недоступен или отказал временно —
 * то же письмо уходит через Brevo, а не ждёт повтора. Отказ по самому адресу — не повод.
 */
export class FallbackTransport implements MailTransport {
  readonly name: string;
  private readonly log = new Logger('Mail');
  constructor(private readonly primary: MailTransport, private readonly backup: MailTransport) {
    this.name = `${primary.name}+${backup.name}`;
  }

  async send(msg: MailMessage): Promise<void> {
    try {
      await this.primary.send(msg);
    } catch (e) {
      if (e instanceof MailPermanentError) throw e;
      this.log.warn(`${this.primary.name}: ${(e as Error).message} — отправляем через ${this.backup.name}`);
      await this.backup.send(msg);
    }
  }
}

/** Транспорт по переменным окружения. Без ключа — журнал, а не падение. */
export function createTransport(env: NodeJS.ProcessEnv): MailTransport {
  const from = {
    email: env.MAIL_FROM?.trim() || 'noreply@qevo.one',
    name: env.MAIL_FROM_NAME?.trim() || 'QEVO',
  };
  const key = env.BREVO_API_KEY?.trim();
  // Brevo шлёт только от подтверждённого у него домена (teamsmrt.com), а свой сервер —
  // от qevo.one: у запасного свой отправитель
  const brevoFrom = env.BREVO_FROM?.trim() ? { ...from, email: env.BREVO_FROM.trim() } : from;
  const brevo = key ? new BrevoTransport(key, brevoFrom) : null;
  const host = env.SMTP_HOST?.trim();
  if (host) {
    const smtp = new SmtpTransport({
      host, port: Number(env.SMTP_PORT) || 587, user: env.SMTP_USER?.trim() || undefined, pass: env.SMTP_PASS,
    }, from);
    return brevo ? new FallbackTransport(smtp, brevo) : smtp;
  }
  return brevo ?? new LogTransport();
}
