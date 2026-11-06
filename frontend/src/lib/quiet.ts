import { setDoNotDisturb } from './sound';

/**
 * Тишина на время глубокой работы (ТЗ-16, п. 49, 56).
 *
 * Источников три: «глубокий фокус», поставленный руками в меню под именем, идущая
 * сессия фокуса и закрытый день с тихим режимом до утра. Пока хоть один включён — молчат звуки, всплывашки и системные
 * уведомления. Сообщения при этом приходят: лента, счётчики и ящик живут как жили,
 * человек увидит всё, когда выйдет из фокуса.
 *
 * Пробиваются только критичные (п. 57): «постучать срочно», безопасность, звонок —
 * вызывающий код помечает их `critical`.
 */
type Source = 'manual' | 'session' | 'workday';
const sources: Record<Source, boolean> = { manual: false, session: false, workday: false };
let quiet = false;

export function setQuietSource(source: Source, on: boolean): void {
  sources[source] = on;
  quiet = sources.manual || sources.session || sources.workday;
  setDoNotDisturb(quiet);
}

export function isQuiet(): boolean {
  return quiet;
}

/*
  #4782, п. 8: статус объясняет, что пробивается. «Занят» и «Быстрые ответы» — личное
  (упоминания и личные сообщения) по настройкам, остальное тихо; «На созвоне» и
  «Обед / перерыв» — тихо совсем; «Свободен» и «Отошёл» — по личным настройкам.
  Глубокий фокус — выше, через sources: тихо всё, кроме критичного.
*/
export type StatusQuiet = 'none' | 'personal' | 'all';
let statusQuiet: StatusQuiet = 'none';
export function setStatusQuiet(level: StatusQuiet): void {
  statusQuiet = level;
}

/** Молчать ли о событии: `personal` — упоминание или личное сообщение, `critical` — стук, безопасность. */
export function quietFor(o: { personal?: boolean; critical?: boolean } = {}): boolean {
  if (o.critical) return false;
  if (quiet || statusQuiet === 'all') return true;
  return statusQuiet === 'personal' && !o.personal;
}
