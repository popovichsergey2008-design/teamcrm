import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { IntegrationCryptoService } from '../integrations/crypto.service';
import { assertPublicHost, fetchNew, MailServer, saveDraft, send, verify } from './mail-client';
import { categorize, MailCategory, mailBriefLine, PROVIDERS, triageText } from './mail-rules';
import { AccountRow, MailboxRepository, MessageRow } from './mailbox.repository';

export interface ConnectInput {
  provider: string; email: string; password: string; username?: string | null;
  imapHost?: string | null; imapPort?: number | null; smtpHost?: string | null; smtpPort?: number | null;
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

/**
 * Личная почта сотрудника в QEVO (ТЗ-18, §8.1–8.2).
 *
 * Подключение — паролем приложения по IMAP/SMTP; письма забираются раз в 5 минут и
 * разбираются правилами по категориям. Ответ бот готовит черновиком в папку
 * «Черновики» самого ящика; отправка — только по подтверждению человека.
 */
@Injectable()
export class MailboxService {
  private readonly log = new Logger('Mailbox');

  constructor(private readonly repo: MailboxRepository, private readonly crypto: IntegrationCryptoService) {}

  providers() {
    return Object.entries(PROVIDERS).map(([id, p]) => ({ id, imapHost: p.imap[0], imapPort: p.imap[1], smtpHost: p.smtp[0], smtpPort: p.smtp[1], hint: p.hint }));
  }

  async accounts(tenantId: string, userId: string) {
    return (await this.repo.accounts(tenantId, userId)).map(view);
  }

  async connect(tenantId: string, userId: string, i: ConnectInput) {
    const email = i.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw AppException.validation('Похоже, адрес почты с ошибкой');
    if (!i.password?.trim()) throw AppException.validation('Нужен пароль приложения');
    const preset = PROVIDERS[i.provider];
    if (!preset && i.provider !== 'custom') throw AppException.validation('Неизвестный почтовик');
    const server: MailServer = {
      email, username: (i.username?.trim() || email), password: i.password.trim(),
      imapHost: (preset ? preset.imap[0] : i.imapHost?.trim()) || '',
      imapPort: preset ? preset.imap[1] : Number(i.imapPort) || 993,
      smtpHost: (preset ? preset.smtp[0] : i.smtpHost?.trim()) || '',
      smtpPort: preset ? preset.smtp[1] : Number(i.smtpPort) || 465,
    };
    try {
      await assertPublicHost(server.imapHost, server.imapPort, 'imap');
      await assertPublicHost(server.smtpHost, server.smtpPort, 'smtp');
      await verify(server);
    } catch (e) {
      throw AppException.validation((e as Error).message);
    }
    const row = await this.repo.upsertAccount({
      tenantId, userId, provider: i.provider, email, username: server.username,
      imapHost: server.imapHost, imapPort: server.imapPort, smtpHost: server.smtpHost, smtpPort: server.smtpPort,
      secretEnc: this.crypto.encrypt(server.password),
    });
    // первые письма — сразу, а не через 5 минут: человек ждёт результат подключения
    await this.syncAccount(row).catch(() => undefined);
    return view((await this.repo.byId(String(row.id)))!);
  }

  async disconnect(tenantId: string, userId: string, id: string) {
    if (!(await this.repo.removeAccount(tenantId, userId, id))) throw AppException.notFound('Ящик не найден');
    return { deleted: true };
  }

  private server(a: AccountRow): MailServer {
    return {
      email: a.email, username: a.username, password: this.crypto.decrypt(a.secret_enc),
      imapHost: a.imap_host, imapPort: a.imap_port, smtpHost: a.smtp_host, smtpPort: a.smtp_port,
    };
  }

  /** Забрать новые письма одного ящика и разобрать их. */
  async syncAccount(a: AccountRow): Promise<number> {
    let added = 0;
    try {
      const vip = new Set(await this.repo.vipEmails(String(a.user_id)));
      const r = await fetchNew(this.server(a), Number(a.last_uid), a.uid_validity !== null ? Number(a.uid_validity) : null);
      if (a.uid_validity !== null && Number(a.uid_validity) !== r.uidValidity) await this.repo.resetMessages(String(a.id));
      for (const m of r.mails) {
        // своё же письмо (копия себе, ответ из другого клиента) — не повод для сводки
        if (m.fromEmail === a.email) continue;
        const client = m.fromEmail ? await this.repo.clientByEmail(String(a.tenant_id), m.fromEmail) : null;
        const cat = categorize({
          fromEmail: m.fromEmail, fromName: m.fromName, subject: m.subject, body: m.body,
          listUnsubscribe: m.listUnsubscribe, clientName: client?.name ?? null, vip: !!m.fromEmail && vip.has(m.fromEmail),
        });
        await this.repo.insertMessage({
          tenantId: String(a.tenant_id), userId: String(a.user_id), accountId: String(a.id), uid: m.uid, messageId: m.messageId,
          fromEmail: m.fromEmail, fromName: m.fromName, to: m.to, subject: m.subject, sentAt: m.sentAt, body: m.body,
          category: cat.category, reason: cat.reason, clientId: client?.id ?? null, isRead: m.seen,
        });
        added += 1;
      }
      await this.repo.syncDone(String(a.id), true, null, r.maxUid, r.uidValidity);
    } catch (e) {
      const msg = (e as Error).message;
      this.log.warn(`ящик ${a.id}: ${msg}`);
      await this.repo.syncDone(String(a.id), false, msg.slice(0, 500));
      throw e;
    }
    return added;
  }

  /** Проход планировщика. */
  async tick(): Promise<void> {
    for (const a of await this.repo.dueAccounts()) {
      if (!(await this.repo.claim(String(a.id)))) continue;
      await this.syncAccount(a).catch(() => undefined);
    }
  }

  async prune() { await this.repo.prune(); }

  // ── для экрана и для бота ──
  async inbox(tenantId: string, userId: string, o: { unreadOnly?: boolean; q?: string | null } = {}) {
    const rows = await this.repo.messages(tenantId, userId, { unreadOnly: o.unreadOnly, q: o.q, limit: 100 });
    return rows.map(messageView);
  }

  async triage(tenantId: string, userId: string): Promise<string | null> {
    const rows = await this.repo.messages(tenantId, userId, { unreadOnly: true, limit: 200, sinceDays: 3 });
    return triageText(rows.map((r) => ({ id: String(r.id), fromName: r.from_name, fromEmail: r.from_email, subject: r.subject, category: r.category, reason: r.reason })));
  }

  async briefLine(userId: string): Promise<string | null> {
    return mailBriefLine(await this.repo.unreadCounts(userId));
  }

  async hasMailbox(tenantId: string, userId: string): Promise<boolean> {
    return (await this.repo.accounts(tenantId, userId)).length > 0;
  }

  async read(tenantId: string, userId: string, id: string) {
    const m = await this.repo.message(tenantId, userId, id);
    if (!m) throw AppException.notFound('Письмо не найдено');
    return { ...messageView(m), body: m.body_text ?? '' };
  }

  /** Ответ или новое письмо: куда, тема, ссылка на исходное — общая подготовка для черновика и отправки. */
  private async outgoing(tenantId: string, userId: string, p: { replyTo?: string | null; to?: string | null; subject?: string | null; text: string }) {
    const accounts = await this.repo.accounts(tenantId, userId);
    if (!accounts.length) throw AppException.conflict('Почта не подключена — подключите ящик в «Настройки → Почта»');
    let account = accounts[0];
    let to = p.to?.trim() || '';
    let subject = p.subject?.trim() || '';
    let inReplyTo: string | null = null;
    if (p.replyTo) {
      const orig = await this.repo.message(tenantId, userId, p.replyTo);
      if (!orig) throw AppException.notFound('Письмо, на которое отвечаем, не найдено');
      account = accounts.find((a) => String(a.id) === String(orig.account_id)) ?? account;
      to = to || orig.from_email || '';
      subject = subject || (/^re:/i.test(orig.subject ?? '') ? orig.subject! : `Re: ${orig.subject ?? ''}`.trim());
      inReplyTo = orig.message_id;
    }
    if (!EMAIL.test(to)) throw AppException.validation('Не понял, кому писать — нужен адрес почты');
    if (!p.text?.trim()) throw AppException.validation('Пустое письмо');
    return { account, mail: { to, subject: subject || 'Без темы', text: p.text.trim(), inReplyTo } };
  }

  async draft(tenantId: string, userId: string, p: { replyTo?: string | null; to?: string | null; subject?: string | null; text: string }) {
    const { account, mail } = await this.outgoing(tenantId, userId, p);
    try {
      const folder = await saveDraft(this.server(account), mail);
      return { folder, to: mail.to, subject: mail.subject, account: account.email };
    } catch (e) {
      throw AppException.conflict(`Черновик не сохранился: ${(e as Error).message}`);
    }
  }

  async send(tenantId: string, userId: string, p: { replyTo?: string | null; to?: string | null; subject?: string | null; text: string }) {
    const { account, mail } = await this.outgoing(tenantId, userId, p);
    try {
      await send(this.server(account), mail, account.provider === 'gmail');
      return { to: mail.to, subject: mail.subject, account: account.email };
    } catch (e) {
      throw AppException.conflict(`Письмо не ушло: ${(e as Error).message}`);
    }
  }

  /** Предпросмотр для карточки бота: что, кому, от какого ящика — без отправки. */
  async prepare(tenantId: string, userId: string, p: { replyTo?: string | null; to?: string | null; subject?: string | null; text: string }) {
    const { account, mail } = await this.outgoing(tenantId, userId, p);
    return { from: account.email, ...mail };
  }
}

function view(a: AccountRow) {
  return {
    id: String(a.id), provider: a.provider, email: a.email, status: a.status, lastError: a.last_error,
    lastSyncAt: a.last_sync_at, imapHost: a.imap_host, smtpHost: a.smtp_host,
  };
}

function messageView(m: MessageRow) {
  return {
    id: String(m.id), from: m.from_name || m.from_email, fromEmail: m.from_email, subject: m.subject ?? '', sentAt: m.sent_at,
    category: m.category as MailCategory, reason: m.reason, client: m.client_name ?? null, isRead: m.is_read,
    preview: (m.body_text ?? '').replace(/\s+/g, ' ').slice(0, 200), mailbox: m.email ?? null,
  };
}
