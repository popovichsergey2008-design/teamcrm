/**
 * Обратная связь интерфейса (ТЗ-23): звук, вибрация, микродвижение — одной точкой.
 *
 * Фичи не играют звук и не трогают вибрацию сами: они сообщают, ЧТО случилось
 * (`feedback('task.completed', { el })`), а что из этого слышно, ощутимо и видно,
 * решает таблица событий в ленивом модуле. Так звук не дублируется между модулями,
 * а настройки, тишина и «не чаще раза в 300 мс» соблюдаются в одном месте.
 *
 * Здесь — только тонкая заглушка: реализация со звуками и стилями грузится на первом
 * касании страницы (§35) и в стартовую сборку не попадает.
 */
export type FeedbackEvent =
  | 'tap'                // нажатие, результат которого ещё не известен (§39)
  | 'task.completed' | 'task.created' | 'task.approved'
  | 'ai.started' | 'ai.completed' | 'postcall.ready'
  | 'focus.started' | 'focus.completed' | 'focus.dayCompleted'
  | 'kudos.sent' | 'news.published' | 'milestone' | 'poll.voted'
  | 'action.confirmed' | 'warning' | 'error';

export interface FeedbackOptions {
  /** Элемент, на котором показать движение или акцент ИИ. */
  el?: Element | null;
  /** Сколько сразу (пачка задач): звук один, а не пять (§42–43). */
  count?: number;
}

/** Личные настройки эффектов — из аккаунта, общие на все устройства (решение 11.10). */
export interface EffectsPrefs { haptics?: boolean; ai?: boolean; celebration?: boolean; minimal?: boolean }

let accountPrefs: EffectsPrefs = {};
export function setEffectsPrefs(p: EffectsPrefs | undefined): void { accountPrefs = p ?? {}; }
export function effectsPrefs(): Required<EffectsPrefs> {
  return {
    haptics: accountPrefs.haptics !== false,
    ai: accountPrefs.ai !== false,
    celebration: accountPrefs.celebration !== false,
    minimal: accountPrefs.minimal === true,
  };
}

/** Звуки действий — на устройстве (в опенспейсе выключают, дома нет). */
const KEY_SOUND = 'teamcrm.sound.effects';
export const effectSoundOn = (): boolean => { try { return localStorage.getItem(KEY_SOUND) !== '0'; } catch { return true; } };
export function setEffectSound(on: boolean): void { try { localStorage.setItem(KEY_SOUND, on ? '1' : '0'); } catch { /* приватный режим */ } }

let impl: Promise<typeof import('./feedback-impl')> | null = null;
const load = () => (impl ??= import('./feedback-impl'));

export function feedback(event: FeedbackEvent, opts: FeedbackOptions = {}): void {
  void load().then((m) => m.run(event, opts)).catch(() => undefined); // эффект — не повод ломать действие
}

/** Подгрузить заранее, на первом касании: дальше отклик укладывается в 100 мс (§37). */
export function preloadFeedback(): void {
  const go = () => {
    for (const ev of ['pointerdown', 'keydown']) window.removeEventListener(ev, go);
    void load().catch(() => undefined);
  };
  for (const ev of ['pointerdown', 'keydown']) window.addEventListener(ev, go, { passive: true });
}
