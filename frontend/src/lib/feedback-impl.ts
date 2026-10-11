import './feedback.css';
import { platform } from '../platform';
import { isQuiet } from './quiet';
import { focusSoundOn, playNotes } from './sound';
import { effectSoundOn, effectsPrefs, type FeedbackEvent, type FeedbackOptions } from './feedback';
import { decide, type Motion, type SoundToken } from './feedback-rules';

/**
 * Реализация слоя обратной связи (ТЗ-23). Грузится лениво, на первом касании.
 * Что играть — решает `decide` (чистая таблица); здесь только звук, вибрация и класс.
 *
 * Звуки — синтез (решение 11.10): 0 КБ, мгновенно, без запроса. Любой токен можно
 * позже заменить файлом, не трогая фичи: они знают только событие.
 */

/** Звуковые токены (§18–20): девять, не сорок. Громкость нарочно очень низкая (§31). */
type Note = [number, number, number, number, OscillatorType?, number?];
const SOUNDS: Record<SoundToken, Note[]> = {
  // короткий фирменный щелчок: высокая треугольная нота с мгновенной атакой
  ui_click: [[0, 1320, 0.06, 0.035, 'triangle', 0.003]],
  // подтверждение: два лёгких тона вверх — «готово»
  ui_success: [[0, 880, 0.09, 0.04, 'sine', 0.005], [0.06, 1320, 0.14, 0.035, 'sine', 0.005]],
  ui_warning: [[0, 523, 0.12, 0.035, 'triangle'], [0.1, 466, 0.16, 0.03, 'triangle']],
  // ошибка: приглушённо и низко, без резкости (§17)
  ui_error: [[0, 233, 0.16, 0.04, 'sine'], [0.12, 196, 0.22, 0.035, 'sine']],
  ai_start: [[0, 660, 0.1, 0.015, 'sine']],
  // ИИ закончил: мягкий переливчатый сигнал
  ai_ready: [[0, 784, 0.32, 0.03, 'sine'], [0.07, 1175, 0.32, 0.025, 'sine'], [0.14, 1568, 0.4, 0.02, 'sine']],
  // конец фокуса: тёплый «гонг», а не будильник (§12)
  focus_complete: [[0, 392, 1.1, 0.05, 'sine', 0.01], [0, 784, 0.8, 0.02, 'sine', 0.01], [0.25, 523, 1.0, 0.035, 'sine', 0.02]],
  kudos: [[0, 1568, 0.08, 0.025, 'sine', 0.003], [0.05, 2093, 0.08, 0.022, 'sine', 0.003], [0.1, 2637, 0.14, 0.02, 'sine', 0.003]],
  milestone: [[0, 523, 0.18, 0.04], [0.09, 659, 0.18, 0.04], [0.18, 784, 0.2, 0.04], [0.27, 1047, 0.42, 0.04]],
};

let lastSound = -Infinity;
const lastEvent = new Map<FeedbackEvent, number>();

const reducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

export function run(event: FeedbackEvent, opts: FeedbackOptions): void {
  const now = performance.now();
  const out = decide(event, {
    prefs: effectsPrefs(),
    soundOn: effectSoundOn(),
    focusSoundOn: focusSoundOn(),
    quiet: isQuiet(),
    reducedMotion: reducedMotion(),
    sinceSame: now - (lastEvent.get(event) ?? -Infinity),
    sinceSound: now - lastSound,
    hasEl: !!opts.el,
  });
  lastEvent.set(event, now);
  if (out.sound) {
    lastSound = now;
    // звук не обязателен: на экране всегда есть видимое состояние (§47)
    try { playNotes(SOUNDS[out.sound]); } catch { /* тихо */ }
  }
  if (out.haptic) {
    try { platform.haptics.play(out.haptic); } catch { /* не умеет — и не надо */ }
  }
  if (out.motion && opts.el) animate(opts.el, out.motion);
}

const MOTION_MS: Record<Motion, number> = { pop: 260, ai: 900, burst: 700, shake: 320 };

/** Класс на элемент — и снять: только transform/opacity/короткая тень (§50). */
function animate(el: Element, motion: Motion): void {
  const cls = `fx-${motion}`;
  el.classList.remove(cls);
  // перезапуск анимации, если тот же акцент пришёл ещё раз
  void (el as HTMLElement).offsetWidth;
  el.classList.add(cls);
  window.setTimeout(() => el.classList.remove(cls), MOTION_MS[motion] + 50);
}
