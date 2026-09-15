/**
 * Мигание заголовка вкладки: «появилось что-то новое».
 *
 * Зачем: человек работает в другой вкладке, и о новой задаче узнаёт, только когда
 * сам вернётся в CRM. Счётчик в заголовке — `(3) TEAMCRM` — этого не решает: цифру
 * в свёрнутом браузере не разглядывают, а вот дёргающийся заголовок видно боковым
 * зрением. Так сделано в YouGile, и заказчик просил ровно это.
 *
 * Мигаем только когда вкладка не на виду: если человек и так смотрит в приложение,
 * бейджи в панели скажут ему всё сами, а прыгающий заголовок будет мешать.
 */

const BASE_TITLE = 'ANTHILL';
/** Столько держится каждое состояние: реже — незаметно, чаще — рябит. */
const BLINK_MS = 1100;

let unread = 0;
let alertText = '';
let timer: ReturnType<typeof setInterval> | null = null;
let inverted = false;
let listening = false;

/** Спокойный заголовок: с числом непрочитанных, если они есть. */
const calmTitle = () => (unread > 0 ? `(${unread}) ${BASE_TITLE}` : BASE_TITLE);

function render(): void {
  document.title = alertText && inverted ? `(!) ${alertText}` : calmTitle();
}

/**
 * Вернулись во вкладку — мигание кончилось.
 *
 * Слушателей вешаем один раз и навсегда: они дешёвые, а снимать их пришлось бы
 * при каждом старте и остановке, и однажды один остался бы висеть.
 */
function listen(): void {
  if (listening) return;
  listening = true;
  const back = () => { if (!document.hidden) stopTabAlert(); };
  window.addEventListener('focus', back);
  document.addEventListener('visibilitychange', back);
}

/** Счётчик непрочитанных сообщений в заголовке. */
export function setTitleUnread(count: number): void {
  unread = count;
  render();
}

/**
 * Начать мигать: «(!) Новая задача».
 *
 * Пока вкладка открыта и активна — не мигаем вовсе: человек уже здесь.
 */
export function flashTab(text: string): void {
  if (!document.hidden && document.hasFocus()) return;
  alertText = text;
  inverted = true;
  render();
  listen();
  if (timer) clearInterval(timer);
  timer = setInterval(() => { inverted = !inverted; render(); }, BLINK_MS);
}

export function stopTabAlert(): void {
  if (timer) { clearInterval(timer); timer = null; }
  alertText = '';
  inverted = false;
  render();
}

/** Счётчики, по росту которых понятно, что появилось новое. */
export interface AlertCounters {
  /** Новое в моих задачах: чужие изменения, которых я ещё не видел. */
  tasks?: number;
  /** Непрочитанные объявления компании. */
  news?: number;
  /** Приглашения на встречи без ответа. */
  calendar?: number;
  /** Ждут моего решения в «Фокусе дня». */
  decide?: number;
  /** Непрочитанные сообщения в чатах. */
  chats?: number;
}

/**
 * О чём мигать.
 *
 * Порядок проверок — это порядок важности, а не вкус: задача и решение требуют
 * действия, объявление и приглашение — внимания, сообщение подождёт. Мигает один
 * заголовок, поэтому называем самое весомое из появившегося.
 *
 * Считаем только РОСТ: убывание счётчика — это человек разобрал накопившееся, и
 * мигать по такому поводу значит наказывать за работу. Первый замер (`prev` пуст)
 * ничего не зажигает — иначе вкладка мигала бы при каждом открытии приложения.
 */
export function tabAlertMessage(prev: AlertCounters | null, next: AlertCounters): string | null {
  if (!prev) return null;
  const grew = (key: keyof AlertCounters) => (next[key] ?? 0) > (prev[key] ?? 0);
  if (grew('tasks')) return 'Новое в задачах';
  if (grew('decide')) return 'Ждёт вашего решения';
  if (grew('news')) return 'Новое объявление';
  if (grew('calendar')) return 'Приглашение на встречу';
  if (grew('chats')) return 'Новое сообщение';
  return null;
}
