import { promises as dns } from 'dns';
import { isIP } from 'net';
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';

/**
 * Работа с чужим почтовым сервером: проверка входа, забор новых писем, черновик в
 * папку ящика, отправка. Всё — от имени владельца ящика и только с его паролем
 * приложения.
 */

export interface MailServer {
  email: string; username: string; password: string;
  imapHost: string; imapPort: number; smtpHost: string; smtpPort: number;
}

export interface FetchedMail {
  uid: number; messageId: string | null; fromEmail: string | null; fromName: string | null; to: string[];
  subject: string; sentAt: Date | null; body: string; listUnsubscribe: boolean; seen: boolean;
}

const IMAP_PORTS = [993, 143];
const SMTP_PORTS = [465, 587];
const BODY_MAX = 20_000;
const TIMEOUT_MS = 20_000;

/** Частные, служебные и петлевые адреса: «свой сервер» не должен вести во внутреннюю сеть. */
function privateAddress(ip: string): boolean {
  if (ip.includes(':')) {
    const v = ip.toLowerCase();
    return v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80') || v.startsWith('::ffff:127.') || v === '::';
  }
  const [a, b] = ip.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/**
 * Свой сервер — только во внешний мир и только на почтовые порты. Без этой проверки
 * поле «адрес IMAP» превращалось бы в способ постучаться из нашего сервера в базу,
 * Redis и прочее, что слушает внутри.
 */
export async function assertPublicHost(host: string, port: number, kind: 'imap' | 'smtp'): Promise<void> {
  const ports = kind === 'imap' ? IMAP_PORTS : SMTP_PORTS;
  if (!ports.includes(port)) throw new Error(`Порт ${kind.toUpperCase()} — ${ports.join(' или ')}`);
  const h = host.trim().toLowerCase();
  if (!/^[a-z0-9.-]{3,253}$/.test(h) || h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal')) {
    throw new Error(`Адрес сервера ${kind.toUpperCase()} не похож на почтовый`);
  }
  const addrs = isIP(h) ? [h] : (await dns.lookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new Error(`Сервер ${h} не найден`);
  if (addrs.some(privateAddress)) throw new Error(`Сервер ${h} указывает во внутреннюю сеть — так нельзя`);
}

function imap(s: MailServer): ImapFlow {
  return new ImapFlow({
    host: s.imapHost, port: s.imapPort, secure: s.imapPort === 993,
    auth: { user: s.username, pass: s.password },
    logger: false, socketTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, connectionTimeout: TIMEOUT_MS,
  } as any);
}

function smtp(s: MailServer) {
  return nodemailer.createTransport({
    host: s.smtpHost, port: s.smtpPort, secure: s.smtpPort === 465,
    auth: { user: s.username, pass: s.password },
    connectionTimeout: TIMEOUT_MS, greetingTimeout: TIMEOUT_MS, socketTimeout: TIMEOUT_MS,
  });
}

/** Человеческие слова вместо кодов почтовика: «AUTHENTICATIONFAILED» человеку ничего не скажет. */
export function humanMailError(e: unknown): string {
  const msg = String((e as any)?.responseText ?? (e as any)?.response ?? (e as Error)?.message ?? e);
  if (/auth|login|credentials|password|535|534|invalid/i.test(msg)) return 'Почтовый сервер не принял логин или пароль. Нужен пароль приложения, а не обычный пароль от почты.';
  if (/disabled|not enabled|imap.*(off|disabled)/i.test(msg)) return 'В ящике выключен доступ по IMAP — включите его в настройках почты.';
  if (/timeout|timed out|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENOTFOUND/i.test(msg)) return 'Почтовый сервер не отвечает. Проверьте адрес и порт.';
  return `Почтовый сервер ответил ошибкой: ${msg.slice(0, 160)}`;
}

/** Проверить вход сразу в обе стороны: читать (IMAP) и отправлять (SMTP). */
export async function verify(s: MailServer): Promise<void> {
  const c = imap(s);
  try {
    await c.connect();
    await c.logout();
  } catch (e) {
    try { c.close(); } catch { /* уже закрыт */ }
    throw new Error(humanMailError(e));
  }
  try {
    await smtp(s).verify();
  } catch (e) {
    throw new Error(`Чтение работает, отправка — нет. ${humanMailError(e)}`);
  }
}

/**
 * Новые письма из «Входящих» после uid. Первый раз — за последние 7 дней: тащить архив
 * за годы незачем, разбор нужен для текущей работы.
 */
export async function fetchNew(s: MailServer, afterUid: number, uidValidity: number | null): Promise<{ mails: FetchedMail[]; uidValidity: number; maxUid: number }> {
  const c = imap(s);
  await c.connect();
  const mails: FetchedMail[] = [];
  let validity = 0;
  let maxUid = afterUid;
  try {
    const box = await c.mailboxOpen('INBOX', { readOnly: true });
    validity = Number(box.uidValidity ?? 0);
    // сервер сбросил нумерацию — начинаем заново, иначе пропустим или задвоим письма
    const fresh = !afterUid || (uidValidity !== null && uidValidity !== validity);
    const range = fresh
      ? await c.search({ since: new Date(Date.now() - 7 * 86_400_000) }, { uid: true })
      : await c.search({ uid: `${afterUid + 1}:*` }, { uid: true });
    const uids = (Array.isArray(range) ? range : []).filter((u) => fresh || u > afterUid).slice(-200);
    if (uids.length) {
      for await (const msg of c.fetch(uids, { uid: true, flags: true, source: true }, { uid: true })) {
        const parsed = await simpleParser(msg.source as Buffer);
        const from = parsed.from?.value?.[0];
        const to = (Array.isArray(parsed.to) ? parsed.to : parsed.to ? [parsed.to] : [])
          .flatMap((a) => a.value.map((v) => String(v.address ?? '').toLowerCase())).filter(Boolean);
        const text = (parsed.text ?? (typeof parsed.html === 'string' ? parsed.html.replace(/<[^>]+>/g, ' ') : '') ?? '').trim();
        mails.push({
          uid: Number(msg.uid),
          messageId: parsed.messageId ?? null,
          fromEmail: from?.address ? from.address.toLowerCase() : null,
          fromName: from?.name || null,
          to,
          subject: parsed.subject ?? '',
          sentAt: parsed.date ?? null,
          body: text.slice(0, BODY_MAX),
          listUnsubscribe: parsed.headers.has('list-unsubscribe'),
          seen: msg.flags?.has('\\Seen') ?? false,
        });
        maxUid = Math.max(maxUid, Number(msg.uid));
      }
    }
  } finally {
    await c.logout().catch(() => undefined);
  }
  return { mails, uidValidity: validity, maxUid };
}

function rfc822(s: MailServer, m: { to: string; subject: string; text: string; inReplyTo?: string | null }): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const t = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
    t.sendMail({
      from: s.email, to: m.to, subject: m.subject, text: m.text,
      ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.inReplyTo } : {}),
    }, (err, info: any) => (err ? reject(err) : resolve(info.message as Buffer)));
  });
}

/** Папка по её назначению (\Drafts, \Sent) — у каждого почтовика она называется по-своему. */
async function specialFolder(c: ImapFlow, use: '\\Drafts' | '\\Sent'): Promise<string | null> {
  const list = await c.list();
  return list.find((b) => b.specialUse === use)?.path ?? null;
}

/**
 * Черновик — в папку «Черновики» самого ящика: человек откроет его в своей почте,
 * поправит и отправит сам. Это ничего не задевает у других — поэтому может делаться
 * без подтверждения.
 */
export async function saveDraft(s: MailServer, m: { to: string; subject: string; text: string; inReplyTo?: string | null }): Promise<string> {
  const raw = await rfc822(s, m);
  const c = imap(s);
  await c.connect();
  try {
    const folder = await specialFolder(c, '\\Drafts');
    if (!folder) throw new Error('В ящике не нашлась папка черновиков');
    await c.append(folder, raw, ['\\Draft', '\\Seen']);
    return folder;
  } finally {
    await c.logout().catch(() => undefined);
  }
}

/** Отправить и положить копию в «Отправленные» (Gmail кладёт сам — второй копии ему не нужно). */
export async function send(s: MailServer, m: { to: string; subject: string; text: string; inReplyTo?: string | null }, gmail: boolean): Promise<void> {
  await smtp(s).sendMail({
    from: s.email, to: m.to, subject: m.subject, text: m.text,
    ...(m.inReplyTo ? { inReplyTo: m.inReplyTo, references: m.inReplyTo } : {}),
  });
  if (gmail) return;
  const c = imap(s);
  try {
    await c.connect();
    const folder = await specialFolder(c, '\\Sent');
    if (folder) await c.append(folder, await rfc822(s, m), ['\\Seen']);
  } catch { /* письмо ушло — копия в «Отправленных» не повод сообщать об ошибке */ }
  finally { await c.logout().catch(() => undefined); }
}
