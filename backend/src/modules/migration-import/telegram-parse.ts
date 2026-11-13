import { ImportBundle, ImportChat, ImportChatKind, ImportFile, ImportMessage, ImportPerson } from './import-types';

/**
 * Разбор экспорта Telegram Desktop (#4902, п. 4).
 *
 * Бот Telegram старую историю прочитать не может — API отдаёт только то, что пришло
 * после его добавления. Поэтому путь один: «Telegram Desktop → чат → ⋮ → Экспорт
 * истории чата → формат JSON». Получается result.json (+ папки photos/, files/,
 * если медиа включены). Бывает и полный экспорт аккаунта: тогда в result.json лежит
 * chats.list со всеми чатами, и человек выбирает нужные.
 *
 * Пути медиа в result.json — относительно самого result.json; если файл не включён
 * в экспорт, вместо пути стоит «(File not included. …)».
 */

interface TgEntity { type?: string; text?: string; href?: string }
interface TgMsg {
  id?: number | string; type?: string; date?: string; date_unixtime?: string;
  from?: string | null; from_id?: string; actor?: string;
  text?: string | (string | TgEntity)[];
  reply_to_message_id?: number | string;
  forwarded_from?: string | null;
  photo?: string; file?: string; file_name?: string; mime_type?: string; media_type?: string;
  sticker_emoji?: string; file_size?: number; photo_file_size?: number;
  poll?: { question?: string; answers?: { text?: string }[] };
  location_information?: { latitude?: number; longitude?: number };
  contact_information?: { first_name?: string; last_name?: string; phone_number?: string };
}
interface TgChat { id?: number | string; name?: string | null; type?: string; messages?: TgMsg[] }

/** Текст сообщения: строка или массив кусков с разметкой (ссылки, жирный, упоминания). */
export function telegramText(text: TgMsg['text']): string {
  if (typeof text === 'string') return text;
  if (!Array.isArray(text)) return '';
  return text.map((part) => {
    if (typeof part === 'string') return part;
    const t = part?.text ?? '';
    // у «текстовой ссылки» адрес спрятан за словами — без него ссылка пропала бы
    if (part?.type === 'text_link' && part.href && part.href !== t) return `${t} (${part.href})`;
    return t;
  }).join('');
}

/** Время: date_unixtime точен; date без пояса — время ПК, где делали экспорт. */
export function telegramTime(m: TgMsg): number {
  const unix = Number(m.date_unixtime);
  if (m.date_unixtime && Number.isFinite(unix)) return unix * 1000;
  // старые выгрузки без date_unixtime: читаем как UTC — сдвиг на пояс лучше, чем потеря даты
  const parsed = Date.parse(m.date ? `${m.date}Z` : '');
  return Number.isFinite(parsed) ? parsed : NaN;
}

const NOT_INCLUDED = /^\(.*not included/i;

function mediaFile(m: TgMsg, chatExt: string, base: string, withMedia: boolean): ImportFile | null {
  const path = m.photo ?? m.file;
  if (!path) return null;
  // стикеры — это картинка-эмодзи; переносим смыслом (эмодзи в тексте), а не файлом .tgs
  if (m.media_type === 'sticker') return null;
  const isPhoto = !!m.photo;
  const name = (m.file_name || path.split('/').pop() || (isPhoto ? 'photo.jpg' : 'file')).trim();
  const file: ImportFile = {
    ext: `${chatExt}:${m.id}:${isPhoto ? 'photo' : 'file'}`,
    name,
    mime: isPhoto ? 'image/jpeg' : (m.mime_type || null),
    size: (isPhoto ? m.photo_file_size : m.file_size) ?? null,
    zipPath: null,
  };
  if (NOT_INCLUDED.test(path)) {
    return { ...file, missing: 'файл не включён в экспорт Telegram (при экспорте отметьте фото и файлы)' };
  }
  if (!withMedia) {
    return { ...file, missing: 'загружен только result.json — чтобы перенести файлы, загрузите архив .zip целиком' };
  }
  return { ...file, zipPath: `${base}${path.replace(/^\.\//, '')}` };
}

/** Сообщение Telegram → общий вид. null — служебное («X добавил Y») или пустое. */
export function telegramMessage(m: TgMsg, chatExt: string, base: string, withMedia: boolean): ImportMessage | null {
  if (!m || m.type !== 'message' || m.id === undefined) return null;
  let body = telegramText(m.text);
  if (m.media_type === 'sticker' && m.sticker_emoji) body = body || `[стикер ${m.sticker_emoji}]`;
  if (m.poll?.question) {
    const answers = (m.poll.answers ?? []).map((a) => `— ${a.text ?? ''}`).join('\n');
    body = `Опрос: ${m.poll.question}${answers ? `\n${answers}` : ''}`;
  }
  if (m.location_information) {
    body = body || `[геопозиция ${m.location_information.latitude}, ${m.location_information.longitude}]`;
  }
  if (m.contact_information) {
    const c = m.contact_information;
    body = body || `[контакт ${[c.first_name, c.last_name].filter(Boolean).join(' ')} ${c.phone_number ?? ''}]`.replace(/\s+\]/, ']');
  }
  if (m.forwarded_from) body = `Переслано от ${m.forwarded_from}:\n${body}`;

  const file = mediaFile(m, chatExt, base, withMedia);
  if (!body.trim() && !file) return null;
  return {
    ext: String(m.id),
    at: telegramTime(m),
    authorExt: m.from_id ? String(m.from_id) : null,
    authorName: (m.from || m.actor || 'Удалённый аккаунт').trim(),
    body,
    replyToExt: m.reply_to_message_id !== undefined ? String(m.reply_to_message_id) : null,
    files: file ? [file] : [],
  };
}

function kindOf(type: string | undefined): ImportChatKind | null {
  switch (type) {
    case 'private_group': case 'private_supergroup': case 'public_supergroup':
      return 'tg_group';
    case 'private_channel': case 'public_channel':
      return 'tg_channel';
    case 'personal_chat': case 'bot_chat':
      return 'tg_personal';
    case 'saved_messages':
      return null; // «Избранное» — личные заметки, а не рабочая переписка
    default:
      return 'tg_group';
  }
}

/**
 * result.json → общий вид.
 *
 * `base` — папка result.json внутри архива (пути медиа считаются от неё).
 * `withMedia` — загрузили архив целиком; если только JSON, файлы честно идут
 * в отчёт «не удалось» с подсказкой, что делать.
 */
export function readTelegramExport(json: unknown, base = '', withMedia = false): ImportBundle {
  const root = (json ?? {}) as { messages?: TgMsg[]; chats?: { list?: TgChat[] }; id?: number | string };
  let list: TgChat[];
  if (Array.isArray(root.messages)) list = [root as TgChat];
  else if (Array.isArray(root.chats?.list)) list = root.chats!.list!;
  else throw new Error('Это не экспорт Telegram: в result.json нет сообщений. Экспортируйте историю в формате JSON');

  const people = new Map<string, ImportPerson>();
  const chats: ImportChat[] = [];
  let skippedService = 0;
  const warnings: string[] = [];

  for (const c of list) {
    const kind = kindOf(c.type);
    if (!kind) continue;
    let ext = String(c.id ?? c.name ?? chats.length);
    const messages: ImportMessage[] = [];
    const authors = new Set<string>();
    for (const raw of c.messages ?? []) {
      const m = telegramMessage(raw, ext, base, withMedia);
      if (!m) { skippedService++; continue; }
      messages.push(m);
      if (m.authorExt) {
        authors.add(m.authorExt);
        if (!people.has(m.authorExt)) {
          people.set(m.authorExt, { ext: m.authorExt, name: m.authorName, email: null, isBot: false, deleted: !raw.from });
        }
      }
    }
    if (!messages.length) continue;
    // id личного чата — это id собеседника: у двух сотрудников, переписывавшихся с одним
    // и тем же человеком, он совпадёт, а переписки разные. Добавляем самих участников.
    if (kind === 'tg_personal') ext = `${ext}~${[...authors].sort().join('~')}`.slice(0, 200);
    messages.sort((a, b) => a.at - b.at || Number(a.ext) - Number(b.ext));
    chats.push({
      ext,
      kind,
      title: (c.name || (kind === 'tg_personal' ? 'Личная переписка Telegram' : 'Чат Telegram')).slice(0, 160),
      memberExts: [...authors],
      messages,
    });
  }
  if (!chats.length) warnings.push('В экспорте нет ни одного сообщения, которое можно перенести');

  // Ключ общий для всего Telegram, различают чаты их id: один и тот же чат, выгруженный
  // отдельно и в составе полного экспорта аккаунта, должен узнаваться как один
  return { source: 'telegram', sourceKey: 'tg', people: [...people.values()], chats, skippedService, warnings };
}
