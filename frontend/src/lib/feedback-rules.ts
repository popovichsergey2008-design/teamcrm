import type { FeedbackEvent } from './feedback';
import type { HapticKind } from '../platform/types';

/**
 * Что слышно, ощутимо и видно на каждое событие (ТЗ-23, §27, §57) — чистая таблица и
 * чистое решение, без звука и DOM: их проверяет `npm run check`.
 */
export type SoundToken = 'ui_click' | 'ui_success' | 'ui_warning' | 'ui_error' | 'ai_start' | 'ai_ready' | 'focus_complete' | 'kudos' | 'milestone';
export type Motion = 'pop' | 'ai' | 'burst' | 'shake';

interface Rule {
  sound?: SoundToken;
  haptic?: HapticKind;
  motion?: Motion;
  /** праздничное (§15): только при включённых «праздничных эффектах», иначе — обычный успех */
  celebration?: boolean;
  /** звучит и в тишине по своему выключателю: сам конец тишины (фокус завершён) */
  throughQuiet?: boolean;
}

export const RULES: Record<FeedbackEvent, Rule> = {
  'tap': { haptic: 'light' },
  'task.completed': { sound: 'ui_success', haptic: 'light', motion: 'pop' },
  // щелчок на каждом шаге задачи, а не только на «Готово»: иначе звука не слышно днями (#1523)
  'task.created': { sound: 'ui_click', haptic: 'light', motion: 'pop' },
  'task.moved': { sound: 'ui_click', haptic: 'light', motion: 'pop' },
  'task.checked': { sound: 'ui_click', haptic: 'light' },
  'task.approved': { sound: 'ui_click', haptic: 'success', motion: 'pop' },
  'ai.started': { motion: 'ai' },
  'ai.completed': { sound: 'ai_ready', haptic: 'success', motion: 'ai' },
  'postcall.ready': { sound: 'ai_ready', haptic: 'success', motion: 'ai' },
  'focus.started': { haptic: 'light' },
  // консьерж-поддержка (ТЗ-29): тихий щелчок на подключении инженера, успех на «всё работает»
  'support.engineerJoined': { sound: 'ui_click', haptic: 'light' },
  'support.solved': { sound: 'ui_success', haptic: 'success', motion: 'pop' },
  'focus.completed': { sound: 'focus_complete', haptic: 'success', throughQuiet: true },
  'focus.dayCompleted': { sound: 'milestone', haptic: 'success', motion: 'burst', celebration: true },
  'kudos.sent': { sound: 'kudos', haptic: 'light', motion: 'burst', celebration: true },
  'news.published': { haptic: 'light', motion: 'pop' },
  'milestone': { sound: 'milestone', haptic: 'success', motion: 'burst', celebration: true },
  'poll.voted': { haptic: 'light', motion: 'pop' },
  'action.confirmed': { haptic: 'light' },
  'warning': { haptic: 'warning', motion: 'shake' },
  'error': { sound: 'ui_error', haptic: 'error', motion: 'shake' },
};

/** Не чаще одного звука в 300 мс (§44); одинаковые события подряд в 250 мс — одна пачка (§42). */
export const SOUND_GAP_MS = 300;
export const BATCH_MS = 250;

export interface Context {
  prefs: { haptics: boolean; ai: boolean; celebration: boolean; minimal: boolean };
  /** звуки действий на этом устройстве */
  soundOn: boolean;
  /** свой выключатель звука окончания фокуса */
  focusSoundOn: boolean;
  /** глубокий фокус, сессия, закрытый день */
  quiet: boolean;
  reducedMotion: boolean;
  /** мс с прошлого такого же события и с прошлого звука */
  sinceSame: number;
  sinceSound: number;
  /** есть ли элемент для движения */
  hasEl: boolean;
}

export function decide(event: FeedbackEvent, c: Context): { sound?: SoundToken; haptic?: HapticKind; motion?: Motion } {
  const rule = RULES[event];
  // «минимальные эффекты»: остаётся только обычное состояние интерфейса (§48)
  if (!rule || c.prefs.minimal) return {};
  const repeat = c.sinceSame < BATCH_MS;
  const festive = !!rule.celebration && c.prefs.celebration;
  const out: { sound?: SoundToken; haptic?: HapticKind; motion?: Motion } = {};

  const token = rule.celebration && !festive ? 'ui_success' : rule.sound;
  const allowed = rule.throughQuiet ? c.focusSoundOn : c.soundOn && !c.quiet;
  if (token && allowed && !repeat && c.sinceSound >= SOUND_GAP_MS) out.sound = token;
  if (rule.haptic && c.prefs.haptics && !repeat) out.haptic = rule.haptic;
  if (rule.motion && c.hasEl && !c.reducedMotion) {
    out.motion = rule.motion === 'burst' && !festive ? 'pop'
      : rule.motion === 'ai' && !c.prefs.ai ? 'pop'
        : rule.motion;
  }
  return out;
}
