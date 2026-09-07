import { createHash } from 'crypto';
import type { NoBlock, NoDatabase, NoPage } from './notion.client';

/**
 * Разбор Notion.
 *
 * Здесь всё, что делает импорт осмысленным, и всё, что легко сделать неправильно:
 *
 *  - у Notion НЕТ понятия «доска». Есть база данных со свойствами, и колонками
 *    становится то свойство, которое команда выбрала статусом. Угадать его надо, но
 *    угадать неправильно нельзя — иначе задачи разъедутся по колонкам «Заказчик»;
 *  - текст в Notion лежит не строкой, а массивом кусочков (`rich_text`), и наивное
 *    чтение `.plain_text[0]` теряет всё после первого форматирования;
 *  - страница — это дерево блоков, а описание задачи у нас плоский Markdown.
 */

/** Плоский текст из `rich_text`: кусочки склеиваются, форматирование не теряется. */
export function plain(rich: unknown): string {
  if (!Array.isArray(rich)) return '';
  return rich.map((r: any) => String(r?.plain_text ?? '')).join('').trim();
}

/** Название базы данных → имя проекта. */
export function databaseName(db: NoDatabase): string {
  return (plain(db.title) || 'База Notion').slice(0, 120);
}

/**
 * Какое свойство считать статусом (колонками доски).
 *
 * Порядок: тип `status` (он и создан для этого) → свойство с названием про статус →
 * первый `select`. Если ничего нет — колонок не будет, и все задачи приедут в одну:
 * это честнее, чем разложить их по случайному свойству.
 */
export function pickStatusProperty(db: NoDatabase): string | null {
  const props = Object.entries(db.properties ?? {});
  const byType = props.find(([, p]) => p.type === 'status');
  if (byType) return byType[0];
  const byName = props.find(([name, p]) =>
    p.type === 'select' && /(статус|состояние|этап|status|stage|state|kanban)/i.test(name));
  if (byName) return byName[0];
  const anySelect = props.find(([, p]) => p.type === 'select');
  return anySelect ? anySelect[0] : null;
}

/** Свойство-название страницы: оно всегда одно и всегда типа `title`. */
export function pickTitleProperty(db: NoDatabase): string | null {
  const hit = Object.entries(db.properties ?? {}).find(([, p]) => p.type === 'title');
  return hit ? hit[0] : null;
}

/** Первое свойство подходящего типа с названием по смыслу — для срока, людей и меток. */
export function pickProperty(db: NoDatabase, type: string, re: RegExp): string | null {
  const props = Object.entries(db.properties ?? {}).filter(([, p]) => p.type === type);
  const byName = props.find(([name]) => re.test(name));
  return (byName ?? props[0])?.[0] ?? null;
}

/**
 * Колонки доски из вариантов статуса.
 *
 * У типа `status` варианты уже разложены по группам (To-do / In progress / Complete),
 * и порядок групп — это и есть порядок колонок. У `select` групп нет, поэтому берём
 * порядок вариантов как есть.
 */
export function statusOptions(db: NoDatabase, propertyName: string | null): { name: string; done: boolean }[] {
  if (!propertyName) return [];
  const prop: any = (db.properties ?? {})[propertyName];
  if (!prop) return [];
  const options: any[] = prop.status?.options ?? prop.select?.options ?? [];
  const groups: any[] = prop.status?.groups ?? [];
  const doneIds = new Set<string>(
    groups.filter((g) => String(g.name ?? '').toLowerCase().includes('complete')
      || /(готов|заверш|выполн|done)/i.test(String(g.name ?? '')))
      .flatMap((g) => g.option_ids ?? []),
  );
  return options.map((o) => ({
    name: String(o.name ?? '').slice(0, 80) || 'Без статуса',
    // «Готово» узнаём по группе, а если групп нет — по названию варианта
    done: doneIds.has(o.id) || /(готово|выполнено|заверш|закрыт|done|complete|shipped)/i.test(String(o.name ?? '')),
  }));
}

/** Значение статуса у страницы. */
export function pageStatus(page: NoPage, propertyName: string | null): string | null {
  if (!propertyName) return null;
  const v: any = page.properties?.[propertyName];
  const name = v?.status?.name ?? v?.select?.name;
  return name ? String(name) : null;
}

/** Дата из свойства `date`: берём начало — конец периода нам нечем показать. */
export function pageDate(page: NoPage, propertyName: string | null): string | null {
  if (!propertyName) return null;
  const start = page.properties?.[propertyName]?.date?.start;
  return start ? String(start) : null;
}

/** Люди из свойства `people`: их идентификаторы Notion, сопоставление — снаружи. */
export function pagePeople(page: NoPage, propertyName: string | null): string[] {
  if (!propertyName) return [];
  const arr = page.properties?.[propertyName]?.people;
  return Array.isArray(arr) ? arr.map((p: any) => String(p?.id ?? '')).filter(Boolean) : [];
}

/** Метки из `multi_select`. */
export function pageLabels(page: NoPage, propertyName: string | null): string[] {
  if (!propertyName) return [];
  const arr = page.properties?.[propertyName]?.multi_select;
  return Array.isArray(arr)
    ? arr.map((o: any) => String(o?.name ?? '').trim().slice(0, 48)).filter(Boolean)
    : [];
}

/** Название страницы. */
export function pageTitle(page: NoPage, propertyName: string | null): string {
  if (propertyName) {
    const t = plain(page.properties?.[propertyName]?.title);
    if (t) return t;
  }
  // запасной путь: у страницы может не оказаться ожидаемого свойства — ищем любой title
  for (const v of Object.values(page.properties ?? {})) {
    const t = plain((v as any)?.title);
    if (t) return t;
  }
  return 'Без названия';
}

/** Приоритет из свойства `select` с названием про приоритет. */
export function pagePriority(page: NoPage, propertyName: string | null): 'low' | 'normal' | 'high' | 'urgent' {
  if (!propertyName) return 'normal';
  const v: any = page.properties?.[propertyName];
  const name = String(v?.select?.name ?? v?.status?.name ?? '').toLowerCase();
  if (/(срочн|критич|urgent|critical|p0|p1|highest)/.test(name)) return 'urgent';
  if (/(высок|важн|high)/.test(name)) return 'high';
  if (/(низк|low|minor)/.test(name)) return 'low';
  return 'normal';
}

/**
 * Блоки страницы → Markdown.
 *
 * Переносим то, что переживает переезд осмысленно: абзацы, заголовки, списки, цитаты,
 * код и разделители. Базы внутри страниц, встроенные виджеты и прочее в описание
 * задачи не превращаются — вместо них ставим пометку, чтобы человек не решил, будто
 * текст потерялся.
 */
export function blocksToMarkdown(blocks: NoBlock[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    const t = b.type;
    const text = plain((b as any)[t]?.rich_text);
    switch (t) {
      case 'paragraph':
        if (text) out.push(text);
        break;
      case 'heading_1': out.push(`# ${text}`); break;
      case 'heading_2': out.push(`## ${text}`); break;
      case 'heading_3': out.push(`### ${text}`); break;
      case 'bulleted_list_item': out.push(`- ${text}`); break;
      case 'numbered_list_item': out.push(`1. ${text}`); break;
      case 'quote': out.push(`> ${text}`); break;
      case 'callout': out.push(`> ${text}`); break;
      case 'code': out.push(['```', text, '```'].join('\n')); break;
      case 'divider': out.push('---'); break;
      case 'to_do': break; // пункты списка дел уезжают в чек-лист задачи, а не в текст
      case 'child_database': out.push('_(в Notion здесь вложенная база — она не переносится)_'); break;
      default:
        if (text) out.push(text);
    }
  }
  return out.join('\n\n').trim();
}

/** Пункты `to_do` со страницы → чек-лист задачи: это ровно наш чек-лист. */
export function blocksToChecklist(blocks: NoBlock[]): { text: string; done: boolean }[] {
  return blocks
    .filter((b) => b.type === 'to_do')
    .map((b) => ({ text: plain((b as any).to_do?.rich_text).slice(0, 500), done: !!(b as any).to_do?.checked }))
    .filter((i) => i.text);
}

/**
 * Хеш состояния страницы: по нему повторный прогон пропускает неизменённое.
 *
 * `last_edited_time` не берём: он меняется от любого касания в Notion, включая
 * открытие страницы роботом, и обесценил бы весь смысл хеша.
 */
export function pageHash(i: {
  title: string; description: string; status: string | null; due: string | null;
  labels: string[]; assignee: string | null; checklist: { text: string; done: boolean }[];
  archived: boolean;
}): string {
  const payload = JSON.stringify([
    i.title, i.description, i.status ?? '', i.due ?? '',
    [...i.labels].sort(), i.assignee ?? '',
    i.checklist.map((c) => `${c.text}:${c.done}`), i.archived,
  ]);
  return createHash('sha1').update(payload).digest('hex');
}
