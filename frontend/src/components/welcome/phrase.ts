/**
 * Чистая логика первого запуска (#4620): без React, проверяется в npm run check.
 */

export type Sphere = 'business' | 'it' | 'services' | 'personal' | 'custom';

/** Кнопки-примеры второго вопроса — дословно из документа, порядок под сферу. */
const NAMES = ['Текущие задачи команды', 'Запуск нового проекта', 'Маркетинг и клиенты', 'Мои задачи на неделю'];
const ORDER: Record<Sphere, number[]> = {
  business: [0, 1, 2, 3],
  it: [1, 2, 0, 3],
  services: [0, 2, 1, 3],
  personal: [3, 1, 0, 2],
  custom: [0, 1, 2, 3],
};
export function nameSuggestions(sphere: Sphere): string[] {
  return ORDER[sphere].map((i) => NAMES[i]);
}

const pad = (n: number) => String(n).padStart(2, '0');
const dayOf = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/*
  Час из фразы: «к 15:00», «в 9.30», «до 18 часов», «к 15».
  \w и \b не видят кириллицу — границы слов описаны явно.
*/
const TIME = /(?:^|[\s,])(к|в|до)\s+(\d{1,2})(?:[:.](\d{2})|\s*(?:час[а-я]*|ч\.?))?(?=$|[\s,.!?;])/i;

function timeOf(text: string): { h: number; m: number; plain: boolean } | null {
  const t = TIME.exec(text);
  if (!t) return null;
  const h = Number(t[2]);
  const m = t[3] ? Number(t[3]) : 0;
  // «в 3 этапа» — не время: без минут и «часов» верим только «к 15» и «до 15»
  const plain = !t[3] && !/час|ч/i.test(t[0]);
  if (h > 23 || m > 59 || (plain && t[1].toLowerCase() === 'в')) return null;
  return { h, m, plain };
}

/**
 * Срок задачи из фразы: день — от разбора команды (`date`, YYYY-MM-DD), час — отсюда.
 * Назван только час — сегодня, а если он уже прошёл, завтра. Нет часа — 18:00, как
 * у остальных сроков без времени в QEVO.
 */
export function phraseDeadline(text: string, date: string | null, now: Date): string | null {
  const time = timeOf(text);
  let day = date && /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null;
  if (!day && !time) return null;
  if (!day) {
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), time!.h, time!.m);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    day = dayOf(at);
  }
  const [y, mo, d] = day.split('-').map(Number);
  return new Date(y, mo - 1, d, time ? time.h : 18, time ? time.m : 0).toISOString();
}

const WHEN = [
  /(?:^|[\s,])(?:на\s+)?(?:сегодня|завтра|послезавтра)(?=$|[\s,.!?;])/gi,
  /(?:^|[\s,])(?:к|до|в|во)\s+(?:понедельник[а-я]*|вторник[а-я]*|сред[а-я]*|четверг[а-я]*|пятниц[а-я]*|суббот[а-я]*|воскресень[а-я]*)(?=$|[\s,.!?;])/gi,
  /(?:^|[\s,])(?:(?:к|до)\s+\d{1,2}(?:[:.]\d{2}|\s*(?:час[а-я]*|ч\.?))?|в\s+\d{1,2}(?:[:.]\d{2}|\s*(?:час[а-я]*|ч\.?)))(?=$|[\s,.!?;])/gi,
];

/** Название без срока: «Подготовить план встречи завтра к 15:00» → «Подготовить план встречи». */
export function phraseTitle(title: string): string {
  let t = ` ${String(title ?? '').trim()}`;
  for (const re of WHEN) t = t.replace(re, ' ');
  t = t.replace(/\s+/g, ' ').replace(/[\s,;:—-]+$/, '').trim();
  if (t.length < 3) t = String(title ?? '').trim();
  return t.charAt(0).toUpperCase() + t.slice(1);
}
