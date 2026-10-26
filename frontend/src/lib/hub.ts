import type { IconName } from '../components/Icon';
import type { HubAdded, HubItem, HubOrigin, HubSection } from './api';
import { plural } from './chat-text';

/**
 * Инфоцентр проекта (#4659): чистая логика колонки и паспорта.
 *
 * Отдельным файлом — чтобы проверить без браузера (npm run check) то, что ошибается
 * молча: склонения в бейдже («+1 решения» читается как машинный перевод), иконка по
 * категории и порядок «закреплённые, потом свежие» в мини-карточке.
 */

/** Категории по разделам — те же коды, что у сервера (CHECK в миграции). */
export const HUB_CATEGORIES: Record<HubSection, { value: string; label: string }[]> = {
  passport: [
    { value: 'site', label: 'Сайт' },
    { value: 'app', label: 'Приложение' },
    { value: 'admin', label: 'Админка' },
    { value: 'social', label: 'Соцсети' },
    { value: 'bot', label: 'Бот' },
    { value: 'other', label: 'Другое' },
  ],
  knowledge: [
    { value: 'spec', label: 'ТЗ и спецификации' },
    { value: 'brand', label: 'Брендбук' },
    { value: 'design', label: 'Макеты' },
    { value: 'repo', label: 'Репозиторий' },
    { value: 'api', label: 'API' },
    { value: 'regulation', label: 'Регламенты' },
    { value: 'doc', label: 'Документы' },
    { value: 'other', label: 'Другое' },
  ],
  team: [
    { value: 'contractor', label: 'Подрядчик' },
    { value: 'client', label: 'Заказчик' },
    { value: 'other', label: 'Другое' },
  ],
};

export function categoryLabel(section: HubSection, category: string | null | undefined): string {
  return HUB_CATEGORIES[section].find((c) => c.value === category)?.label ?? '';
}

const CATEGORY_ICON: Record<string, IconName> = {
  site: 'monitor', app: 'zap', admin: 'lock', social: 'megaphone', bot: 'robot',
  spec: 'file', brand: 'image', design: 'edit', repo: 'folder', api: 'plug', regulation: 'shield', doc: 'book',
  contractor: 'handshake', client: 'building',
};

/** Значок записи: по категории, без неё — по виду (файл, контакт, заметка, ссылка). */
export function itemIcon(item: Pick<HubItem, 'kind' | 'category'>): IconName {
  const byCategory = item.category ? CATEGORY_ICON[item.category] : undefined;
  if (byCategory) return byCategory;
  if (item.kind === 'file') return 'paperclip';
  if (item.kind === 'contact') return 'user';
  if (item.kind === 'note') return 'info';
  return 'link';
}

/**
 * Что добавил ИИ — словами для бейджа: «+2 решения, +1 ссылка».
 * Ноль не показываем; пусто — значит и бейджа нет.
 */
export function addedSummary(added: Partial<HubAdded> | null | undefined): string {
  if (!added) return '';
  const parts: [number | undefined, string, string, string][] = [
    [added.decisions, 'решение', 'решения', 'решений'],
    [added.links, 'ссылка', 'ссылки', 'ссылок'],
    [added.files, 'файл', 'файла', 'файлов'],
    [added.contacts, 'контакт', 'контакта', 'контактов'],
    [added.notes, 'заметка', 'заметки', 'заметок'],
  ];
  return parts
    .filter(([n]) => (n ?? 0) > 0)
    .map(([n, one, few, many]) => `+${n} ${plural(n!, one, few, many)}`)
    .join(', ');
}

/** Сколько всего добавил прогон — для числа на свёрнутой полосе. */
export function addedTotal(added: Partial<HubAdded> | null | undefined): number {
  if (!added) return 0;
  return (added.decisions ?? 0) + (added.links ?? 0) + (added.files ?? 0) + (added.contacts ?? 0) + (added.notes ?? 0);
}

/** Мини-карточка: сначала закреплённые, потом самые свежие — и не больше n. */
export function shortlist<T extends Pick<HubItem, 'pinned' | 'createdAt'>>(items: T[], n = 5): T[] {
  return [...items]
    .sort((a, b) => Number(b.pinned) - Number(a.pinned) || String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, n);
}

/** Откуда ИИ взял запись — короткой подсказкой у метки «ИИ». */
export function originLabel(origin: HubOrigin | null | undefined): string {
  switch (origin?.type) {
    case 'chat_message': return 'из сообщения в чате проекта';
    case 'meeting': return 'из созвона';
    case 'task': return 'из закрытой задачи';
    case 'comment': return 'из комментария к задаче';
    default: return 'собрал ИИ-библиотекарь';
  }
}

/** Куда вести по нажатию на «откуда» — путь внутри приложения или null. */
export function originPath(origin: HubOrigin | null | undefined): string | null {
  if (!origin?.id) return null;
  if (origin.type === 'meeting') return `/meetings/${origin.id}`;
  if (origin.type === 'chat_message' && origin.chatId) return `/chat/${origin.chatId}?m=${origin.id}`;
  if (origin.type === 'task' && origin.projectId) return `/projects/${origin.projectId}/task/${origin.id}`;
  return null;
}

/**
 * Ссылку открываем только http(s).
 *
 * Записи приносит и ИИ из переписки: «javascript:» или «data:» в поле адреса —
 * это не ссылка на макет, а код, который выполнится у того, кто нажал.
 */
export function safeHref(url: string | null | undefined): string | null {
  if (!url) return null;
  const s = url.trim();
  return /^https?:\/\//i.test(s) ? s : null;
}

/** «figma.com/file/…» без схемы — дописываем https://, мусор не принимаем. */
export function normalizeUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^https?:\/\//i.test(s)) return safeHref(s);
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) && !/^[^:]+:\d/.test(s)) return null; // чужая схема (mailto:, javascript:)
  if (!/^[^\s/]+\.[^\s/]{2,}/.test(s)) return null;
  return `https://${s}`;
}

/** Домен для подписи: «figma.com» вместо километрового адреса. */
export function hostOf(url: string | null | undefined): string {
  if (!url) return '';
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Подсказка категории по адресу — человек вставил ссылку, категория выбралась сама.
 * Это только начальное значение в форме: поменять можно до сохранения.
 */
export function guessLinkCategory(url: string): { section: HubSection; category: string } {
  const h = hostOf(url);
  const s = url.toLowerCase();
  if (/(^|\.)figma\.com$|(^|\.)miro\.com$/.test(h)) return { section: 'knowledge', category: 'design' };
  if (/(^|\.)(github|gitlab|bitbucket)\.(com|org|io)$/.test(h)) return { section: 'knowledge', category: 'repo' };
  if (/swagger|api-docs|openapi|redoc/.test(s)) return { section: 'knowledge', category: 'api' };
  if (/^docs\.google\.com$|(^|\.)notion\.(so|site)$|(^|\.)confluence/.test(h)) return { section: 'knowledge', category: 'doc' };
  if (/^(t\.me|telegram\.me)$/.test(h) && /bot(\b|$|\?)/.test(s)) return { section: 'passport', category: 'bot' };
  if (/^(t\.me|telegram\.me|vk\.com|youtube\.com|youtu\.be|instagram\.com|dzen\.ru|rutube\.ru)$/.test(h)) return { section: 'passport', category: 'social' };
  if (/(^|\.)(play\.google\.com|apps\.apple\.com)$/.test(h)) return { section: 'passport', category: 'app' };
  if (/^admin\./.test(h) || /\/admin(\/|$)/.test(pathOf(url))) return { section: 'passport', category: 'admin' };
  return { section: 'knowledge', category: 'other' };
}

/** Путь адреса без исключений на кривом вводе. */
function pathOf(url: string): string {
  try { return new URL(url).pathname; } catch { return ''; }
}

/** Категория файла по имени: ТЗ, брендбук, регламент — то, что ищут чаще всего. */
export function guessFileCategory(name: string): string {
  const n = name.toLowerCase();
  if (/(^|[^a-zа-яё])(тз|бриф|spec|specification)|техническ|задани|спецификац/.test(n)) return 'spec';
  if (/брендбук|brandbook|brand|логотип|logo|лого|шрифт|font|палитр|\.(ttf|otf|woff2?|svg|ai|eps)$/.test(n)) return 'brand';
  if (/регламент|инструкц|policy|правила/.test(n)) return 'regulation';
  if (/\.(fig|sketch|xd)$|макет/.test(n)) return 'design';
  return 'doc';
}

/** Свёрнута ли колонка — на человека и проект. Хранилище бывает недоступно: молча по умолчанию. */
const stateKey = (userId: string, projectId: string) => `teamcrm.hub.${userId}.${projectId}`;
export function readCollapsed(userId: string, projectId: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(stateKey(userId, projectId));
    return v === null ? fallback : v === '1';
  } catch { return fallback; }
}
export function writeCollapsed(userId: string, projectId: string, collapsed: boolean): void {
  try { localStorage.setItem(stateKey(userId, projectId), collapsed ? '1' : '0'); } catch { /* нет хранилища */ }
}

/** «24 октября» — дата решения без года, если год текущий. */
export function dayLabel(iso: string | null | undefined, now = new Date()): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts: Intl.DateTimeFormatOptions = d.getFullYear() === now.getFullYear()
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' };
  return d.toLocaleDateString('ru-RU', opts);
}

/** Кто правит паспорт и запускает сбор вручную: руководство и владелец проекта. */
export function canCollect(role: string | undefined, userId: string | undefined, ownerId: string | null | undefined): boolean {
  return role === 'owner' || role === 'manager' || (!!ownerId && !!userId && String(ownerId) === String(userId));
}
