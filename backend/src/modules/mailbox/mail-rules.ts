/**
 * Почта секретаря (ТЗ-18, §8.1) — разбор правилами.
 *
 * Категория письма считается без модели: рассылку выдаёт заголовок List-Unsubscribe
 * и адрес noreply, счёт — слова «счёт / invoice / оплата», клиента — адрес из
 * карточки клиента (ТЗ-17), важность — VIP-отправитель и срочные слова. Так разбор
 * работает у всех, включая организации без ключа ИИ, и всегда объясним: у каждой
 * категории есть причина.
 */

export type MailCategory = 'critical' | 'action' | 'client' | 'invoice' | 'fyi' | 'newsletter';

export interface MailFacts {
  fromEmail: string | null;
  fromName: string | null;
  subject: string;
  body: string;
  listUnsubscribe: boolean;
  /** Адрес есть в контактах клиента — имя клиента. */
  clientName: string | null;
  vip: boolean;
}

// \b в JS не видит кириллицу — границы слов не используем
const URGENT = /(срочн|urgent|asap|критичн|авари|немедленно|сегодня до|до конца дня|претензи|штраф)/i;
const INVOICE = /(сч[её]т[ а-я]*(на оплату|№|n\s?\d)|invoice|оплат[аиуы]|акт сверки|акт выполненных|платёжк|платежк|реквизит)/i;
const ACTION = /(\?|прошу|просим|просьба|нужно|необходимо|подтвердите|согласуйте|ответьте|пришлите|можете ли|сможете ли|please|could you|can you)/i;
const NOREPLY = /^(no-?reply|noreply|do-?not-?reply|mailer-daemon|notifications?|news(letter)?|info|marketing)@/i;

export function categorize(m: MailFacts): { category: MailCategory; reason: string } {
  const text = `${m.subject}\n${m.body.slice(0, 3000)}`;
  const robot = m.listUnsubscribe || (m.fromEmail ? NOREPLY.test(m.fromEmail) : false);
  if (m.vip && !robot) return { category: 'critical', reason: 'важный отправитель' };
  if (!robot && URGENT.test(text)) return { category: 'critical', reason: 'срочные слова в письме' };
  if (INVOICE.test(text)) return { category: 'invoice', reason: 'счёт или оплата' };
  if (robot) return { category: 'newsletter', reason: m.listUnsubscribe ? 'рассылка (есть отписка)' : 'автоматическое письмо' };
  if (m.clientName) return { category: 'client', reason: `клиент ${m.clientName}` };
  if (ACTION.test(text)) return { category: 'action', reason: 'просьба или вопрос' };
  return { category: 'fyi', reason: 'к сведению' };
}

export const CATEGORY_TITLE: Record<MailCategory, string> = {
  critical: 'Важно',
  action: 'Требуют действия',
  client: 'От клиентов',
  invoice: 'Счета и оплата',
  fyi: 'К сведению',
  newsletter: 'Рассылки',
};

const ORDER: MailCategory[] = ['critical', 'action', 'client', 'invoice', 'fyi', 'newsletter'];

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

export interface MailRow { id: string; fromName: string | null; fromEmail: string | null; subject: string | null; category: MailCategory; reason: string | null }

/** Разбор ящика текстом: по категориям, рассылки — только числом. */
export function triageText(rows: MailRow[]): string | null {
  if (!rows.length) return null;
  const out: string[] = [];
  for (const cat of ORDER) {
    const list = rows.filter((r) => r.category === cat);
    if (!list.length) continue;
    if (cat === 'newsletter' || cat === 'fyi') { out.push(`${CATEGORY_TITLE[cat]}: ${list.length}`); continue; }
    const shown = list.slice(0, 5).map((r) => `— #${r.id} ${r.fromName || r.fromEmail || 'неизвестно'}: «${clip(r.subject || 'без темы', 70)}»`);
    out.push(`${CATEGORY_TITLE[cat]} (${list.length}):\n${shown.join('\n')}${list.length > 5 ? `\n— и ещё ${list.length - 5}` : ''}`);
  }
  return out.join('\n');
}

/** Строка для утренней сводки: только то, что требует внимания. */
export function mailBriefLine(counts: Partial<Record<MailCategory, number>>): string | null {
  const parts: string[] = [];
  if (counts.critical) parts.push(`важных ${counts.critical}`);
  if (counts.action) parts.push(`ждут действия ${counts.action}`);
  if (counts.client) parts.push(`от клиентов ${counts.client}`);
  if (counts.invoice) parts.push(`счетов ${counts.invoice}`);
  return parts.length ? `Почта (непрочитанное): ${parts.join(', ')}` : null;
}

/** Адреса почтовиков: пароль приложения — единственный способ без регистрации у каждого. */
export const PROVIDERS: Record<string, { imap: [string, number]; smtp: [string, number]; hint: string }> = {
  gmail: { imap: ['imap.gmail.com', 993], smtp: ['smtp.gmail.com', 465], hint: 'Нужен пароль приложения: Аккаунт Google → Безопасность → Двухэтапная аутентификация → Пароли приложений.' },
  yandex: { imap: ['imap.yandex.ru', 993], smtp: ['smtp.yandex.ru', 465], hint: 'Нужен пароль приложения: Яндекс ID → Безопасность → Пароли приложений → Почта. И включите IMAP в настройках почты.' },
  mailru: { imap: ['imap.mail.ru', 993], smtp: ['smtp.mail.ru', 465], hint: 'Нужен пароль для внешнего приложения: Настройки → Безопасность → Пароли для внешних приложений.' },
  outlook: { imap: ['outlook.office365.com', 993], smtp: ['smtp.office365.com', 587], hint: 'Microsoft пускает по паролю только если администратор не выключил это. Если не подключится — нужен вход через Microsoft, он появится позже.' },
};
