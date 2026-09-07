import { createHash } from 'crypto';
import type { TrCard, TrLabel } from './trello.client';

/**
 * Правила переноса Trello → CRM.
 *
 * Вынесены отдельно и под тесты, потому что это места, где импорт ошибается молча:
 * приоритет угадывается по цвету метки, «выполнено» в Trello живёт в двух разных
 * местах сразу, а хеш карточки решает, трогать задачу при повторном прогоне или нет.
 */

/**
 * Приоритет по меткам.
 *
 * В Trello приоритета нет вовсе — команды обозначают его цветной меткой. Красная и
 * названия со словом «срочно» — это urgent, оранжевая и «важно» — high, зелёная и
 * «низкий» — low. Угадывание намеренно осторожное: неверный приоритет хуже никакого,
 * поэтому всё непонятное остаётся обычным.
 */
export function priorityFromLabels(labels: TrLabel[]): 'low' | 'normal' | 'high' | 'urgent' {
  const names = labels.map((l) => (l.name ?? '').toLowerCase());
  const colors = labels.map((l) => (l.color ?? '').toLowerCase());
  const has = (re: RegExp) => names.some((n) => re.test(n));

  if (has(/(срочн|критич|горит|urgent|critical|asap|p0|p1)/)) return 'urgent';
  if (has(/(важн|высок|high|major)/)) return 'high';
  if (has(/(низк|потом|low|minor|later)/)) return 'low';
  if (colors.includes('red')) return 'urgent';
  if (colors.includes('orange')) return 'high';
  if (colors.includes('green')) return 'low';
  return 'normal';
}

/**
 * Считать ли карточку завершённой.
 *
 * В Trello это ДВА разных признака, и путать их нельзя: `closed` — карточка убрана в
 * архив (её вообще не видно на доске), `dueComplete` — срок отмечен выполненным.
 * Оба означают «работа сделана», и оба должны закрывать задачу у нас — иначе
 * переехавшая доска показывает сотню сделанных дел как незакрытые.
 */
export function isCardDone(card: TrCard): boolean {
  return !!card.closed || !!card.dueComplete;
}

/** Метки Trello без цвета и без имени в CRM не нужны: имя — это и есть метка. */
export function labelNames(labels: TrLabel[]): string[] {
  const out = new Set<string>();
  for (const l of labels) {
    const name = (l.name ?? '').trim();
    if (name) out.add(name.slice(0, 48));
  }
  return [...out];
}

/** Цвет метки Trello → наш HEX. Незнакомый цвет — серый, а не случайный. */
const LABEL_COLORS: Record<string, string> = {
  green: '#2e9e5b', yellow: '#d6a417', orange: '#e0791a', red: '#d64545',
  purple: '#8b5cf6', blue: '#3b82f6', sky: '#0ea5e9', lime: '#84cc16',
  pink: '#ec4899', black: '#4b5563',
};
export function labelColor(color: string | null): string {
  return LABEL_COLORS[(color ?? '').toLowerCase()] ?? '#6b7280';
}

/**
 * Хеш состояния карточки: по нему повторный импорт пропускает неизменённое.
 *
 * В хеш входит ровно то, что мы переносим. Добавили поле в перенос — добавьте и сюда,
 * иначе повторный прогон будет считать карточку неизменённой и правка не доедет.
 * `dateLastActivity` не используем: он меняется от любого чиха в Trello, включая
 * переоткрытие карточки, и обесценил бы весь смысл хеша.
 */
export function cardHash(card: TrCard, assigneeId: string | null): string {
  const payload = JSON.stringify([
    card.name ?? '',
    card.desc ?? '',
    card.idList ?? '',
    card.due ?? '',
    isCardDone(card),
    labelNames(card.labels ?? []).sort(),
    assigneeId ?? '',
    (card.checklists ?? []).map((c) => (c.checkItems ?? []).map((i) => `${i.name}:${i.state}`)),
  ]);
  return createHash('sha1').update(payload).digest('hex');
}

/**
 * Описание карточки + ссылки на внешние вложения.
 *
 * Внешние вложения Trello (ссылки на Google Docs, Figma и прочее) файлами не являются
 * и скачаны быть не могут. Потерять их нельзя — это половина контекста задачи, —
 * поэтому они уезжают в описание списком.
 */
export function descriptionWithLinks(desc: string, links: { name: string; url: string }[]): string {
  const body = (desc ?? '').trim();
  if (!links.length) return body;
  const list = links.map((l) => `- [${l.name || l.url}](${l.url})`).join('\n');
  return [body, '**Ссылки из Trello:**', list].filter(Boolean).join('\n\n');
}

/**
 * Имя проекта из доски Trello.
 *
 * Просто имя доски: в отличие от YouGile, у Trello нет обёртки «проект → доска»,
 * и придумывать её незачем.
 */
export function projectName(boardName: string): string {
  return (boardName || 'Доска Trello').trim().slice(0, 120);
}
