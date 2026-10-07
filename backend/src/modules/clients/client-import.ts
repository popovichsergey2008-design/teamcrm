import { CLIENT_SOURCES, CLIENT_STATUSES, normalizeDomain, normalizeEmail, normalizePhone } from './client-rules';

/**
 * Импорт клиентов из CSV/XLSX (ТЗ-17, п. 50–52): сопоставление колонок и разбор
 * строки. Чтение файла — общее с импортом задач (integrations/file/table-read).
 */
export const CLIENT_FIELDS = [
  'name', 'legalName', 'type', 'status', 'segment', 'source', 'owner', 'website', 'city', 'address',
  'taxId', 'description', 'contactName', 'position', 'phone', 'email', 'telegram',
] as const;
export type ClientField = (typeof CLIENT_FIELDS)[number];

export const FIELD_TITLES: Record<ClientField, string> = {
  name: 'Название / имя', legalName: 'Юридическое название', type: 'Тип (компания/частное лицо)', status: 'Статус',
  segment: 'Сегмент', source: 'Источник', owner: 'Ответственный (имя или почта)', website: 'Сайт', city: 'Город',
  address: 'Адрес', taxId: 'ИНН / налоговый номер', description: 'Описание', contactName: 'Контактное лицо',
  position: 'Должность контакта', phone: 'Телефон', email: 'Email', telegram: 'Telegram',
};

/** Слова в заголовке → поле. Порядок важен: «название компании» раньше «компании». */
const GUESS: [ClientField, RegExp][] = [
  ['legalName', /(юр.*назв|полное наимен|legal)/i],
  ['name', /(назв|наимен|компан|клиент|организац|company|client|account|^name$|^имя$|фио)/i],
  ['contactName', /(контактн.*лиц|контакт$|contact( name| person)?$|представит)/i],
  ['position', /(должн|position|title|роль)/i],
  ['phone', /(тел|phone|моб|mobile)/i],
  ['email', /(e-?mail|почт|мейл)/i],
  ['telegram', /(telegram|телеграм|tg)/i],
  ['website', /(сайт|site|web|url|домен)/i],
  ['taxId', /(инн|inn|vat|tax|унп|бин)/i],
  ['owner', /(ответств|менеджер|manager|owner|куратор)/i],
  ['segment', /(сегмент|segment|категор)/i],
  ['source', /(источник|source|канал)/i],
  ['status', /(статус|status|стадия)/i],
  ['type', /(тип|type|юр.*физ)/i],
  ['city', /(город|city)/i],
  ['address', /(адрес|address)/i],
  ['description', /(описан|комментар|примеч|note|descr)/i],
];

export function guessMapping(headers: string[]): Record<string, ClientField | null> {
  const used = new Set<ClientField>();
  const out: Record<string, ClientField | null> = {};
  for (const h of headers) {
    const hit = GUESS.find(([f, re]) => !used.has(f) && re.test(h.trim()));
    out[h] = hit ? hit[0] : null;
    if (hit) used.add(hit[0]);
  }
  return out;
}

const STATUS_WORDS: Record<string, string> = {
  лид: 'lead', lead: 'lead', новый: 'lead', активный: 'active', active: 'active', клиент: 'active',
  пауза: 'paused', paused: 'paused', неактивный: 'inactive', inactive: 'inactive', потерян: 'lost', lost: 'lost', отказ: 'lost',
};
const SOURCE_WORDS: Record<string, string> = {
  сайт: 'website', website: 'website', рекомендац: 'referral', referral: 'referral', реклам: 'advertising',
  telegram: 'telegram', телеграм: 'telegram', email: 'email', почта: 'email', партн: 'partner', partner: 'partner',
};

export interface ParsedRow {
  ok: boolean;
  error?: string;
  client: {
    name: string; legalName: string | null; type: 'company' | 'person'; status: string; segment: string | null;
    source: string; website: string | null; domain: string | null; city: string | null; address: string | null;
    taxId: string | null; description: string | null; ownerHint: string | null;
  };
  contact: { firstName: string; lastName: string | null; position: string | null; phone: string | null; phoneNorm: string | null; email: string | null; emailNorm: string | null; telegram: string | null } | null;
}

/** Строка таблицы → клиент и его основной контакт. Плохая строка не ломает весь импорт (п. 52). */
export function parseRow(row: string[], headers: string[], mapping: Record<string, ClientField | null>): ParsedRow {
  const get = (f: ClientField) => {
    const i = headers.findIndex((h) => mapping[h] === f);
    const v = i >= 0 ? String(row[i] ?? '').trim() : '';
    return v || null;
  };
  const name = get('name') ?? get('legalName') ?? get('contactName');
  const typeRaw = (get('type') ?? '').toLowerCase();
  const statusRaw = (get('status') ?? '').toLowerCase();
  const sourceRaw = (get('source') ?? '').toLowerCase();
  const status = Object.entries(STATUS_WORDS).find(([w]) => statusRaw.startsWith(w))?.[1]
    ?? ((CLIENT_STATUSES as readonly string[]).includes(statusRaw) ? statusRaw : 'active');
  const source = Object.entries(SOURCE_WORDS).find(([w]) => sourceRaw.includes(w))?.[1]
    ?? ((CLIENT_SOURCES as readonly string[]).includes(sourceRaw) ? sourceRaw : 'import');
  const website = get('website');
  const email = get('email');
  const phone = get('phone');
  const contactName = get('contactName');
  const client = {
    name: (name ?? '').slice(0, 160), legalName: get('legalName'),
    type: (/физ|частн|person|ип/.test(typeRaw) ? 'person' : 'company') as 'company' | 'person',
    status, segment: get('segment'), source, website,
    domain: normalizeDomain(website) ?? normalizeDomain(email),
    city: get('city'), address: get('address'), taxId: get('taxId')?.replace(/\s/g, '') ?? null,
    description: get('description'), ownerHint: get('owner'),
  };
  if (!name) return { ok: false, error: 'нет названия', client, contact: null };
  if (email && !normalizeEmail(email)) return { ok: false, error: `почта «${email}» не похожа на адрес`, client, contact: null };
  const hasContact = contactName || phone || email || get('telegram');
  const [first, ...rest] = String(contactName ?? '').split(/\s+/).filter(Boolean);
  return {
    ok: true,
    client,
    contact: hasContact ? {
      firstName: first ?? (client.type === 'person' ? client.name : 'Основной контакт'),
      lastName: rest.join(' ') || null, position: get('position'),
      phone, phoneNorm: normalizePhone(phone), email, emailNorm: normalizeEmail(email), telegram: get('telegram'),
    } : null,
  };
}
