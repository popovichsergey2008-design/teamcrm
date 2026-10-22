/**
 * Отдел заботы (ТЗ-34, #4620) — чистые правила без браузера: время ответа словами,
 * строка прогресса, детектор заминок и встряхивания. Проверяются в scripts/logic-check.
 *
 * Цифры не выдумываем: время ответа — живая медиана; нет данных — норма из документа
 * (25 секунд) как цель, а не обещание с потолка.
 */

/** Норма из документа: «Живой инженер ответит за 25 секунд». */
export const CARE_NORM_SEC = 25;

export interface CareEstimate {
  kind: 'now' | 'queue' | 'offline';
  minutes: [number, number] | null;
}

/** Секунды ответа: медиана, если есть и разумна, иначе норма документа. */
export function careSeconds(medianSec: number | null | undefined): number {
  return medianSec && medianSec > 0 ? Math.round(medianSec) : CARE_NORM_SEC;
}

/** Коротко — для островка: «25 сек», «3 мин», в очереди «4–6 мин»; никого нет — пусто. */
export function careShort(estimate: CareEstimate | null, medianSec: number | null | undefined): string {
  if (!estimate || estimate.kind === 'offline') return '';
  if (estimate.kind === 'queue' && estimate.minutes) return `${estimate.minutes[0]}–${estimate.minutes[1]} мин`;
  const s = careSeconds(medianSec);
  return s < 90 ? `${s} сек` : `${Math.round(s / 60)} мин`;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10, m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
}

/** Полностью — для подсказки: «25 секунд», «21 секунду», «2 минуты». */
export function careLong(medianSec: number | null | undefined): string {
  const s = careSeconds(medianSec);
  if (s < 90) return `${s} ${plural(s, 'секунду', 'секунды', 'секунд')}`;
  const m = Math.round(s / 60);
  return `${m} ${plural(m, 'минуту', 'минуты', 'минут')}`;
}

/** Подсказка островка — дословно по документу (п. 4.1), с живым временем вместо «25». */
export function careTooltip(medianSec: number | null | undefined): string {
  return `Qevo: Помощь быстрее мысли. Живой инженер ответит за ${careLong(medianSec)} и решит любой вопрос по задачам, проектам и команде`;
}

/** Строка шапки (п. 2.1): «Отдел заботы Qevo на связи 24/7 • Среднее время ответа сейчас: 24 сек». */
export function careHeadline(estimate: CareEstimate | null, medianSec: number | null | undefined): string {
  if (estimate?.kind === 'offline') return 'Отдел заботы Qevo на связи 24/7 • Сейчас инженеров нет на связи — ответим, как только подключатся';
  if (estimate?.kind === 'queue' && estimate.minutes) {
    return `Отдел заботы Qevo на связи 24/7 • Среднее время ответа сейчас: ${estimate.minutes[0]}–${estimate.minutes[1]} мин`;
  }
  return `Отдел заботы Qevo на связи 24/7 • Среднее время ответа сейчас: ${careShort({ kind: 'now', minutes: null }, medianSec)}`;
}

/** Прогресс инженера — то, что уходит в шапку, на кружок и в уведомление Android. */
export interface CareProgress { engineer: string; text: string; percent: number; minutesLeft: number | null }

/** «Инженер Максим переносит …: готово 85% (осталось 2 мин). Пришлем тихий пуш по готовности» (п. 4.3). */
export function progressLine(p: CareProgress): string {
  const who = p.engineer.trim().split(/\s+/)[0] || 'Инженер';
  if (p.percent >= 100) return `Инженер ${who} ${p.text}: готово 100%.`;
  const left = p.minutesLeft !== null ? ` (осталось ${p.minutesLeft} мин)` : '';
  return `Инженер ${who} ${p.text}: готово ${p.percent}%${left}. Пришлем тихий пуш по готовности`;
}

/** Что видно на экране — для шторки Shake-to-Help (п. 2.1); сделок у нас нет, есть задачи. */
export function screenPhrase(entityType: string | undefined, entityId: string | undefined, title: string | undefined, route: string | undefined): string {
  const name = title ? ` «${title}»` : '';
  if (entityType === 'task' && entityId) return `Видим открытую задачу №${entityId}${name}.`;
  if (entityType === 'project') return `Видим открытый проект${name || (entityId ? ` №${entityId}` : '')}.`;
  if (entityType === 'chat') return `Видим открытый чат${name}.`;
  return `Видим ваш экран${route ? ` «${SECTION_NAMES[route] ?? route}»` : ''}.`;
}

const SECTION_NAMES: Record<string, string> = {
  focus: 'Фокус дня', projects: 'Проекты', tasks: 'Задачи', chat: 'Чаты', calendar: 'Календарь',
  news: 'Новости', settings: 'Настройки', profile: 'Личный кабинет', support: 'Служба заботы', radar: 'Радар',
  clients: 'Клиенты',
};

// ── детектор заминок (п. 2.5, «Сегодня» 5.1) ────────────────────────────────────
export type StallKind = 'rage' | 'save' | 'file';
export interface Stall { kind: StallKind; label: string; format?: boolean }

/** Три быстрых нажатия по одной и той же кнопке — за это время. */
export const RAGE_WINDOW_MS = 1500;
/** Две неудачные записи подряд — в пределах двух минут. */
export const FAIL_WINDOW_MS = 2 * 60_000;
/** Предлагаем помощь не чаще раза в 10 минут: навязчивая забота — уже не забота. */
export const STALL_COOLDOWN_MS = 10 * 60_000;

/**
 * Детектор: копит нажатия и неудачные записи, отвечает «заминка» или null.
 *
 * Нажатие «без эффекта» — по неактивной кнопке или такое, после которого на экране ничего
 * не поменялось (`changed` считает вызывающий). Неудачная запись — POST/PUT/PATCH с
 * ошибкой: два раза за две минуты по одному адресу — человек упёрся.
 */
export function createStallDetector() {
  let taps: { key: string; at: number; dead: boolean }[] = [];
  let fails: { key: string; at: number }[] = [];
  let lastShown = -Infinity;

  const fire = (s: Stall, now: number): Stall | null => {
    if (now - lastShown < STALL_COOLDOWN_MS) return null;
    lastShown = now;
    taps = []; fails = [];
    return s;
  };

  return {
    /** Нажатие: key — какая кнопка, dead — неактивная или ничего не произошло. */
    tap(key: string, label: string, dead: boolean, now: number): Stall | null {
      taps = taps.filter((t) => now - t.at <= RAGE_WINDOW_MS && t.key === key);
      taps.push({ key, at: now, dead });
      if (taps.length >= 3 && taps.every((t) => t.dead)) return fire({ kind: 'rage', label }, now);
      return null;
    },
    /** Неудачный запрос на запись. */
    fail(method: string, path: string, status: number, now: number): Stall | null {
      if (!/^(POST|PUT|PATCH)$/i.test(method) || status === 401) return null;
      const base = path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id');
      const file = /\/(files|attachments|upload)/.test(base);
      fails = fails.filter((f) => now - f.at <= FAIL_WINDOW_MS);
      fails.push({ key: base, at: now });
      // файл к задаче: хватает одной неудачи — человек уже ждал загрузку
      if (file) return fire({ kind: 'file', label: '', format: status === 415 || status === 422 || status === 400 }, now);
      if (fails.filter((f) => f.key === base).length >= 2) return fire({ kind: 'save', label: whatSaved(base) }, now);
      return null;
    },
    /** Показали помощь по другой причине — счётчик паузы общий. */
    shown(now: number): void { lastShown = now; },
  };
}

/** Что именно не сохраняется — по адресу запроса, человеческим словом. */
export function whatSaved(path: string): string {
  if (/\/tasks/.test(path)) return 'задача';
  if (/\/projects|\/columns|\/boards/.test(path)) return 'проект';
  if (/\/chats|\/messages/.test(path)) return 'сообщение';
  if (/\/calendar|\/events/.test(path)) return 'событие';
  if (/\/filters|\/views/.test(path)) return 'фильтр';
  if (/\/users|\/team|\/invites/.test(path)) return 'приглашение';
  return 'изменение';
}

/**
 * Карточка заминки (п. 5.1): «Привет! Я Максим из Отдела заботы Qevo. Вижу, … Давай я … за тебя за 30 секунд?»
 * Для файла — текст документа почти дословно; «из-за формата» — только когда сервер так и ответил.
 */
export function stallText(s: Stall, name: string | null): string {
  const me = name ? `Привет! Я ${name.trim().split(/\s+/)[0]} из Отдела заботы Qevo.` : 'Привет! Я из Отдела заботы Qevo.';
  if (s.kind === 'file') {
    return s.format
      ? `${me} Вижу, файл не прикрепляется к задаче из-за формата. Давай я сконвертирую и прикреплю его за тебя за 30 секунд?`
      : `${me} Вижу, файл не прикрепляется к задаче. Давай я прикреплю его за тебя за 30 секунд?`;
  }
  if (s.kind === 'save') return `${me} Вижу, ${s.label} не сохраняется. Давай я сохраню это за тебя за 30 секунд?`;
  return `${me} Вижу, кнопка${s.label ? ` «${s.label}»` : ''} не срабатывает. Давай я сделаю это за тебя за 30 секунд?`;
}

/** Что уходит инженеру по «Да, сделай за меня»: заминка словами, контекст — сам. */
export function stallRequest(s: Stall): string {
  if (s.kind === 'file') return `Не получается прикрепить файл к задаче${s.format ? ' — пишет про формат' : ''}. Сделайте, пожалуйста, за меня.`;
  if (s.kind === 'save') return `Не сохраняется ${s.label}: пробовал(а) несколько раз. Сделайте, пожалуйста, за меня.`;
  return `Нажимаю на кнопку${s.label ? ` «${s.label}»` : ''} — ничего не происходит. Сделайте, пожалуйста, за меня.`;
}

// ── встряхивание (п. 2.1) ────────────────────────────────────────────────────────
/** Порог рывка, м/с² без учёта тяжести: обычная ходьба даёт 3–6, встряхивание — 15+. */
export const SHAKE_THRESHOLD = 15;
/** Три рывка за это время — встряхнули, а не уронили телефон в сумку. */
export const SHAKE_WINDOW_MS = 900;

export function createShakeDetector() {
  let peaks: number[] = [];
  let last = -Infinity;
  return {
    /** Ускорение без тяжести (или с ней — тогда вычитаем g) — true, когда встряхнули. */
    sample(x: number, y: number, z: number, withGravity: boolean, now: number): boolean {
      const mag = Math.sqrt(x * x + y * y + z * z) - (withGravity ? 9.81 : 0);
      if (Math.abs(mag) < SHAKE_THRESHOLD) return false;
      // один рывок длится несколько отсчётов — считаем его одним пиком
      if (peaks.length && now - peaks[peaks.length - 1] < 120) return false;
      peaks = peaks.filter((t) => now - t <= SHAKE_WINDOW_MS);
      peaks.push(now);
      if (peaks.length >= 3 && now - last > 3000) { peaks = []; last = now; return true; }
      return false;
    },
  };
}
