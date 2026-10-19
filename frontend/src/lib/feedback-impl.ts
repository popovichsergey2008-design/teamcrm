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

/**
 * Звуковые токены (§18–20): девять, не сорок.
 *
 * Тихие, но СЛЫШНЫЕ. Сначала громкость была 0,02–0,04 — на динамиках ноутбука это
 * тишина, и заказчик звуков не услышал вовсе (#1523, 19.10). Теперь — уровень
 * сигнала о сообщении (0,14), который слышен и не раздражает; щелчок короткий,
 * поэтому громче по пику.
 */
type Note = [number, number, number, number, OscillatorType?, number?];
const SOUNDS: Record<SoundToken, Note[]> = {
  // короткий фирменный щелчок: два обертона с мгновенной атакой — «тык», а не писк
  ui_click: [[0, 1760, 0.05, 0.16, 'triangle', 0.002], [0, 880, 0.06, 0.1, 'sine', 0.002]],
  // подтверждение: два лёгких тона вверх — «готово»
  ui_success: [[0, 880, 0.12, 0.14, 'sine', 0.005], [0.08, 1320, 0.2, 0.13, 'sine', 0.005]],
  ui_warning: [[0, 523, 0.14, 0.12, 'triangle'], [0.11, 466, 0.18, 0.1, 'triangle']],
  // ошибка: приглушённо и низко, без резкости (§17)
  ui_error: [[0, 233, 0.18, 0.15, 'sine'], [0.13, 196, 0.24, 0.13, 'sine']],
  ai_start: [[0, 660, 0.12, 0.07, 'sine']],
  // ИИ закончил: мягкий переливчатый сигнал
  ai_ready: [[0, 784, 0.34, 0.12, 'sine'], [0.08, 1175, 0.34, 0.1, 'sine'], [0.16, 1568, 0.42, 0.08, 'sine']],
  // конец фокуса: тёплый «гонг», а не будильник (§12)
  focus_complete: [[0, 392, 1.1, 0.15, 'sine', 0.01], [0, 784, 0.8, 0.06, 'sine', 0.01], [0.25, 523, 1.0, 0.11, 'sine', 0.02]],
  kudos: [[0, 1568, 0.09, 0.1, 'sine', 0.003], [0.06, 2093, 0.09, 0.09, 'sine', 0.003], [0.12, 2637, 0.16, 0.08, 'sine', 0.003]],
  milestone: [[0, 523, 0.18, 0.13], [0.09, 659, 0.18, 0.13], [0.18, 784, 0.2, 0.13], [0.27, 1047, 0.45, 0.13]],
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
