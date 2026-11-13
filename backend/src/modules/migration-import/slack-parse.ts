import JSZip from 'jszip';
import { ImportBundle, ImportChat, ImportChatKind, ImportFile, ImportMessage, ImportPerson } from './import-types';

/**
 * Разбор архива экспорта Slack (#4902, п. 4).
 *
 * Формат: users.json, channels.json (открытые), groups.json (закрытые), dms.json
 * (личные), mpims.json (групповые лички) и папка на каждый разговор с файлами по
 * дням — `<канал>/<ГГГГ-ММ-ДД>.json`. Личные лежат в папках по id, остальные — по имени.
 * Архив иногда пересжимают с верхней папкой — корень ищем по users.json.
 *
 * Самих файлов в экспорте нет — только ссылки с токеном (`?t=xoxe-…`). Ссылку без
 * токена скачать нельзя, и это сразу пишем причиной в отчёт, а не узнаём при скачивании.
 */

/** Служебные строки Slack: «вошёл в канал», «сменил тему». Переписки в них нет. */
const SERVICE_SUBTYPES = new Set([
  'channel_join', 'channel_leave', 'group_join', 'group_leave',
  'channel_archive', 'channel_unarchive', 'group_archive', 'group_unarchive',
  'channel_topic', 'channel_purpose', 'channel_name', 'group_topic', 'group_purpose', 'group_name',
  'pinned_item', 'unpinned_item', 'bot_add', 'bot_remove', 'sh_room_created',
  'reminder_add', 'joiner_notification', 'tombstone',
]);

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

interface SlackUser {
  id?: string; name?: string; real_name?: string; deleted?: boolean; is_bot?: boolean; team_id?: string;
  profile?: { email?: string; real_name?: string; display_name?: string };
}
interface SlackConv {
  id?: string; name?: string; members?: string[]; is_archived?: boolean;
  topic?: { value?: string }; purpose?: { value?: string };
}
interface SlackFile {
  id?: string; name?: string; title?: string; mimetype?: string; size?: number; mode?: string;
  url_private_download?: string; url_private?: string; permalink?: string; is_external?: boolean;
}
interface SlackMsg {
  type?: string; subtype?: string; ts?: string; user?: string; bot_id?: string; username?: string; text?: string;
  thread_ts?: string; files?: SlackFile[]; file?: SlackFile; team?: string;
  user_profile?: { real_name?: string; display_name?: string; name?: string };
  bot_profile?: { name?: string };
  attachments?: { fallback?: string; text?: string; title?: string; title_link?: string }[];
}

async function readJson<T>(zip: JSZip, path: string): Promise<T | null> {
  const entry = zip.file(path);
  if (!entry) return null;
  try {
    return JSON.parse(await entry.async('string')) as T;
  } catch {
    throw new Error(`Файл «${path}» в архиве повреждён — выгрузите архив из Slack заново`);
  }
}

/** Корень экспорта внутри архива: папка, где лежит users.json или channels.json. */
export function slackRoot(paths: string[]): string | null {
  const marks = paths.filter((p) => /(^|\/)(users|channels)\.json$/.test(p));
  if (!marks.length) return null;
  // самый короткий путь — верхний уровень; вложенный channels.json внутри папки
  // канала (если канал так назван) не должен сбить корень
  const best = marks.sort((a, b) => a.length - b.length)[0];
  return best.slice(0, best.lastIndexOf('/') + 1);
}

/** Есть ли в ссылке токен доступа: без него Slack отдаёт страницу входа, а не файл. */
export function slackUrlHasToken(url: string | null | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return !!u.searchParams.get('t');
  } catch {
    return false;
  }
}

/**
 * Текст Slack → обычный текст.
 *
 * В Slack ссылки, упоминания и каналы — в угловых скобках с id: `<@U123>`,
 * `<#C1|general>`, `<https://x|подпись>`. Оставь мы их как есть — в перенесённой
 * переписке вместо имён были бы непонятные коды. Сущности &lt; &gt; &amp; Slack
 * экранирует сам — раскрываем последними, чтобы не принять их за разметку.
 */
export function slackText(
  text: string,
  names: Map<string, string>,
  channels: Map<string, string>,
): string {
  if (!text) return '';
  const out = text.replace(/<([^<>]+)>/g, (_m, inner: string) => {
    const [target, label] = splitLabel(inner);
    if (target.startsWith('@')) {
      const id = target.slice(1);
      return `@${label || names.get(id) || id}`;
    }
    if (target.startsWith('#')) {
      const id = target.slice(1);
      return `#${label || channels.get(id) || id}`;
    }
    if (target.startsWith('!')) {
      // <!here>, <!channel>, <!subteam^S1|@дизайн>, <!date^…|вчера>
      if (label) return label;
      const word = target.slice(1).split('^')[0];
      return `@${word}`;
    }
    if (target.startsWith('mailto:')) return label || target.slice(7);
    if (label && label !== target) return `${label} (${target})`;
    return target;
  });
  return out.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function splitLabel(inner: string): [string, string] {
  const at = inner.indexOf('|');
  return at < 0 ? [inner, ''] : [inner.slice(0, at), inner.slice(at + 1)];
}

/** Время Slack «1700000000.000200» → миллисекунды. */
export function slackTs(ts: string | undefined): number {
  const n = Number(ts);
  return Number.isFinite(n) ? Math.round(n * 1000) : NaN;
}

function personName(u: SlackUser): string {
  return (u.profile?.real_name || u.real_name || u.profile?.display_name || u.name || u.id || 'Участник Slack').trim();
}

function fileOf(f: SlackFile, msgTs: string): ImportFile {
  const name = (f.name || f.title || 'файл').trim();
  const url = f.url_private_download || f.url_private || null;
  const base: ImportFile = {
    ext: f.id || `${msgTs}:${name}`,
    name,
    mime: f.mimetype || null,
    size: typeof f.size === 'number' ? f.size : null,
    url,
  };
  // Удалённые и скрытые бесплатным тарифом файлы Slack оставляет «надгробием» без ссылки
  if (f.mode === 'tombstone') return { ...base, url: null, missing: 'файл удалён в Slack' };
  if (f.mode === 'hidden_by_limit') return { ...base, url: null, missing: 'файл скрыт ограничением бесплатного тарифа Slack' };
  if (f.is_external || f.mode === 'external') return { ...base, url: null, missing: 'внешний файл (Google Диск и т. п.) — в сообщении оставлена ссылка' };
  if (!url) return { ...base, missing: 'в архиве нет ссылки на файл' };
  if (!slackUrlHasToken(url)) return { ...base, missing: 'в архиве ссылка без токена доступа — Slack не отдаёт такой файл' };
  return base;
}

/** Сообщение Slack → общий вид. null — служебная строка или пустое. */
export function slackMessage(
  m: SlackMsg,
  names: Map<string, string>,
  channels: Map<string, string>,
): ImportMessage | null {
  if (!m || !m.ts) return null;
  if (m.subtype && SERVICE_SUBTYPES.has(m.subtype)) return null;

  const raw = [m.files ?? [], m.file ? [m.file] : []].flat().filter(Boolean);
  const files = raw.map((f) => fileOf(f, m.ts!));
  let body = slackText(m.text ?? '', names, channels);
  // ссылку на внешний файл оставляем в тексте: сам файл не наш, а дорогу к нему терять нельзя
  for (const f of raw) {
    if ((f.is_external || f.mode === 'external') && (f.permalink || f.url_private)) {
      body = `${body}${body ? '\n' : ''}${f.title || f.name || 'Файл'}: ${f.permalink || f.url_private}`;
    }
  }
  // вложения ботов (карточки Jira, GitHub) — их текст и есть суть сообщения
  if (!body && m.attachments?.length) {
    body = m.attachments
      .map((a) => [a.title, a.text || a.fallback, a.title_link].filter(Boolean).join('\n'))
      .filter(Boolean)
      .join('\n\n');
  }
  if (!body.trim() && !files.length) return null;

  const isBot = !m.user && !!m.bot_id;
  const authorExt = m.user ?? (m.bot_id ? `bot:${m.bot_id}` : null);
  const authorName = isBot
    ? (m.bot_profile?.name || m.username || 'Бот Slack')
    : (names.get(m.user ?? '') || m.user_profile?.real_name || m.user_profile?.display_name || m.user_profile?.name || m.username || 'Участник Slack');

  const inThread = !!m.thread_ts && m.thread_ts !== m.ts;
  return {
    ext: m.ts,
    at: slackTs(m.ts),
    authorExt,
    authorName,
    body,
    threadExt: inThread ? m.thread_ts! : null,
    broadcast: inThread && m.subtype === 'thread_broadcast',
    files,
  };
}

/**
 * Весь архив Slack → общий вид.
 *
 * Читаем целиком в память: экспорт Slack — это текст без файлов, и даже на 100 000
 * сообщений это десятки мегабайт JSON. Сообщения каждого разговора сортируем по
 * времени: файлы по дням и порядок внутри них Slack не гарантирует, а порядок
 * вставки у нас = порядок ленты.
 */
export async function readSlackExport(zip: JSZip): Promise<ImportBundle> {
  const paths = Object.keys(zip.files).filter((p) => !zip.files[p].dir);
  const root = slackRoot(paths);
  if (root === null) {
    throw new Error('Это не архив экспорта Slack: в нём нет users.json и channels.json');
  }

  const users = (await readJson<SlackUser[]>(zip, `${root}users.json`)) ?? [];
  const channels = (await readJson<SlackConv[]>(zip, `${root}channels.json`)) ?? [];
  const groups = (await readJson<SlackConv[]>(zip, `${root}groups.json`)) ?? [];
  const dms = (await readJson<SlackConv[]>(zip, `${root}dms.json`)) ?? [];
  const mpims = (await readJson<SlackConv[]>(zip, `${root}mpims.json`)) ?? [];

  const people: ImportPerson[] = users.filter((u) => u.id).map((u) => ({
    ext: u.id!,
    name: personName(u),
    email: (u.profile?.email || '').trim().toLowerCase() || null,
    isBot: !!u.is_bot || u.id === 'USLACKBOT',
    deleted: !!u.deleted,
  }));
  const names = new Map(people.map((p) => [p.ext, p.name]));
  const channelNames = new Map<string, string>();
  for (const c of [...channels, ...groups, ...mpims]) if (c.id && c.name) channelNames.set(c.id, c.name);

  // Файлы по дням, разложенные по папкам разговоров
  const byFolder = new Map<string, string[]>();
  for (const p of paths) {
    if (!p.startsWith(root)) continue;
    const rel = p.slice(root.length);
    const parts = rel.split('/');
    if (parts.length !== 2 || !DAY_FILE.test(parts[1])) continue;
    const list = byFolder.get(parts[0]) ?? [];
    list.push(p);
    byFolder.set(parts[0], list);
  }

  const warnings: string[] = [];
  let skippedService = 0;
  const used = new Set<string>();
  const chats: ImportChat[] = [];

  const take = async (conv: SlackConv, kind: ImportChatKind, title: string) => {
    const folder = [conv.name, conv.id].find((f) => f && byFolder.has(f));
    if (!folder) return; // разговор без единого дня переписки — переносить нечего
    used.add(folder);
    const messages: ImportMessage[] = [];
    for (const day of byFolder.get(folder)!.sort()) {
      const list = (await readJson<SlackMsg[]>(zip, day)) ?? [];
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const m = slackMessage(raw, names, channelNames);
        if (m) messages.push(m);
        else skippedService++;
      }
    }
    messages.sort((a, b) => a.at - b.at || (a.ext < b.ext ? -1 : a.ext > b.ext ? 1 : 0));
    chats.push({
      ext: conv.id || folder,
      kind,
      title: title.slice(0, 160),
      memberExts: Array.isArray(conv.members) ? conv.members.filter(Boolean) : [],
      description: (conv.purpose?.value || conv.topic?.value || '').trim() || null,
      messages,
    });
  };

  for (const c of channels) await take(c, 'channel', c.name || c.id || 'канал');
  for (const c of groups) await take(c, 'private', c.name || c.id || 'закрытый канал');
  for (const c of dms) {
    const who = (c.members ?? []).map((id) => names.get(id) || id).join(' и ');
    await take(c, 'dm', who || 'Личная переписка');
  }
  for (const c of mpims) {
    const who = (c.members ?? []).map((id) => names.get(id) || id).join(', ');
    await take(c, 'mpim', who || c.name || 'Групповая переписка');
  }
  // Папка есть, а в списках разговора нет (выгрузка без channels.json): считаем
  // открытым каналом — лучше перенести, чем молча потерять историю
  for (const folder of byFolder.keys()) {
    if (used.has(folder)) continue;
    await take({ id: folder, name: folder }, 'channel', folder);
    warnings.push(`Папка «${folder}» не описана в channels.json — перенесём её как открытый канал`);
  }

  // Команда — по полю team у людей и сообщений; без него ключ строим из id каналов,
  // чтобы повтор того же архива всё равно узнавался
  const team = users.find((u) => u.team_id)?.team_id
    || chats.map((c) => c.ext).sort().join(',').slice(0, 80)
    || 'export';
  return { source: 'slack', sourceKey: `slack:${team}`.slice(0, 120), people, chats, skippedService, warnings };
}
