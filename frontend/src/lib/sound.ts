/**
 * Звуки уведомлений: сигнал о сообщении и звонок при входящем вызове.
 *
 * Синтезируем через WebAudio, а не проигрываем файлы: звук в бандле — лишние килобайты
 * и лишний запрос, который к тому же режет политика безопасности страницы.
 *
 * Главная сложность здесь не в самих нотах, а в том, что браузер запрещает звук на
 * странице, где человек ещё ничего не нажал. Раньше это выглядело так: контекст
 * создавался при первом сообщении, оставался в состоянии suspended — и сигнала не было
 * вовсе, причём молча. Поэтому контекст будим на ПЕРВОМ же касании страницы, каким бы
 * оно ни было, и дальше он готов заранее.
 *
 * Настройки живут в localStorage, а не на сервере: звук — свойство места, а не человека.
 * На рабочем ноутбуке в опенспейсе его выключают, дома на том же аккаунте — нет.
 */

const KEY_MESSAGES = 'teamcrm.sound.messages';
const KEY_CALLS = 'teamcrm.sound.calls';

/** «Не беспокоить»: пока включён глубокий фокус, молчим совсем. */
let doNotDisturb = false;
export function setDoNotDisturb(active: boolean): void {
  doNotDisturb = active;
  if (active) stopRingtone();
}

const on = (key: string) => localStorage.getItem(key) !== '0'; // по умолчанию включено
export const soundPrefs = () => ({ messages: on(KEY_MESSAGES), calls: on(KEY_CALLS) });
export function setSoundPref(kind: 'messages' | 'calls', enabled: boolean): void {
  localStorage.setItem(kind === 'messages' ? KEY_MESSAGES : KEY_CALLS, enabled ? '1' : '0');
  if (kind === 'calls' && !enabled) stopRingtone();
}

let ctx: AudioContext | null = null;
let unlocked = false;

function context(): AudioContext | null {
  try {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = ctx ?? new Ctor();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch {
    return null; // звук — дополнение; без него уведомление всё равно видно
  }
}

/**
 * Разбудить звук на первом действии человека.
 *
 * Вызывается один раз при старте приложения. Слушатели снимаются сразу после первого
 * срабатывания: держать их дальше незачем.
 */
export function unlockAudio(): void {
  if (unlocked) return;
  const wake = () => {
    unlocked = true;
    context();
    for (const ev of ['pointerdown', 'keydown', 'touchstart']) window.removeEventListener(ev, wake);
  };
  for (const ev of ['pointerdown', 'keydown', 'touchstart']) {
    window.addEventListener(ev, wake, { once: false, passive: true });
  }
}

/** Одна нота. Огибающая обязательна: прямоугольный старт слышен как щелчок. */
function note(at: number, freq: number, seconds: number, volume: number): void {
  const audio = ctx;
  if (!audio) return;
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(volume, at + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  gain.connect(audio.destination);

  const osc = audio.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(freq, at);
  osc.connect(gain);
  osc.start(at);
  osc.stop(at + seconds + 0.02);
}

/** Короткий сигнал о новом сообщении: две ноты вверх, не похоже на системную ошибку. */
export function playMessageChime(): void {
  if (doNotDisturb || !soundPrefs().messages) return;
  const audio = context();
  if (!audio) return;
  const now = audio.currentTime;
  note(now, 660, 0.18, 0.14);
  note(now + 0.09, 880, 0.22, 0.14);
}

/** Сигнал о госте, который просится в созвон, — тише и ниже, чем сообщение. */
export function playKnock(): void {
  if (doNotDisturb || !soundPrefs().messages) return;
  const audio = context();
  if (!audio) return;
  const now = audio.currentTime;
  note(now, 520, 0.16, 0.12);
  note(now + 0.16, 520, 0.16, 0.12);
}

/**
 * Звонок входящего вызова.
 *
 * Повторяется, пока звонят: одиночный «дилинь» на звонке бесполезен — человек
 * отходит от стола, а вызов ждёт секунды. Через минуту замолкаем сами: если к этому
 * времени не подошли, дальше звонить некому и незачем, окно вызова остаётся на экране.
 */
const RING_PERIOD_MS = 2600;
const RING_LIMIT_MS = 60_000;
let ringTimer: ReturnType<typeof setInterval> | null = null;
let ringStop: ReturnType<typeof setTimeout> | null = null;

function ringOnce(): void {
  const audio = context();
  if (!audio) return;
  const now = audio.currentTime;
  // две пары нот — узнаваемый телефонный рисунок, а не одинокий писк
  note(now, 780, 0.32, 0.16);
  note(now + 0.42, 620, 0.32, 0.16);
}

export function startRingtone(): void {
  if (doNotDisturb || !soundPrefs().calls) return;
  if (ringTimer) return; // уже звоним — второй вызов не наслаиваем
  ringOnce();
  ringTimer = setInterval(ringOnce, RING_PERIOD_MS);
  ringStop = setTimeout(stopRingtone, RING_LIMIT_MS);
}

export function stopRingtone(): void {
  if (ringTimer) clearInterval(ringTimer);
  if (ringStop) clearTimeout(ringStop);
  ringTimer = null;
  ringStop = null;
}

/** Проба звука из настроек: человек должен услышать ровно то, что его ждёт. */
export function previewSound(kind: 'messages' | 'calls'): void {
  const audio = context();
  if (!audio) return;
  if (kind === 'messages') {
    const now = audio.currentTime;
    note(now, 660, 0.18, 0.14);
    note(now + 0.09, 880, 0.22, 0.14);
  } else {
    ringOnce();
  }
}
