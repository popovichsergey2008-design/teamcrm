/**
 * Разбор ответа первой линии.
 *
 * Помощник отвечает клиенту текстом, а службе нужны ещё три вещи: насколько он уверен,
 * о чём вообще обращение и кому его отдавать. Просить у модели отдельный вызов ради
 * классификации — платить дважды за один и тот же разбор, поэтому она дописывает
 * последней строкой служебную метку, а мы её снимаем перед показом человеку.
 *
 * Метка машинная и однострочная намеренно: модель ошибается в форматировании тем реже,
 * чем проще требование. Всё, что не разобралось, молча превращается в «средняя
 * уверенность и никакой классификации» — это хуже, чем точный разбор, но несравнимо
 * лучше, чем показать человеку JSON или уронить ответ целиком.
 */

export type Confidence = 'high' | 'medium' | 'low';
export type Priority = 'normal' | 'high' | 'critical';

export interface AiVerdict {
  /** Что показать человеку: без служебной метки. */
  text: string;
  confidence: Confidence;
  /** О чём обращение: `how_to`, `technical_error`, `billing`, `access`… */
  intent: string | null;
  /** Кому отдавать: навык дежурного (этап 3). */
  skill: string | null;
  priority: Priority;
  /** Суть в одну строку — для очереди и для записки специалисту. */
  summary: string | null;
}

const MARK = '#META';
const CONFIDENCE: Confidence[] = ['high', 'medium', 'low'];
const PRIORITY: Priority[] = ['normal', 'high', 'critical'];

/**
 * Что дописать к вопросу человека, чтобы получить метку.
 *
 * Держим рядом с разбором: требование и его понимание обязаны меняться вместе, иначе
 * однажды мы будем снимать метку, которую больше никто не ставит.
 */
export const META_RULES = [
  'В САМОМ КОНЦЕ ответа добавь отдельной последней строкой служебную метку вида:',
  `${MARK} {"confidence":"high|medium|low","intent":"how_to|technical_error|billing|access|other",`
  + '"skill":"одно слово","priority":"normal|high|critical","summary":"суть в одной строке"}',
  'confidence: high — ответ найден в справочнике и точен; medium — общая рекомендация;'
  + ' low — надёжного ответа нет, нужен человек.',
  'Метку человек не увидит, она снимается. Не пиши её нигде, кроме последней строки.',
].join('\n');

const clip = (v: unknown, max: number): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/** Снять метку и понять, что помощник о себе думает. */
export function parseAnswer(raw: string): AiVerdict {
  const text = String(raw ?? '');
  const lines = text.split('\n');
  // Ищем с конца: метка должна быть последней, но модель иногда добавляет пустую строку.
  const idx = [...lines].reverse().findIndex((l) => l.trim().startsWith(MARK));
  const at = idx === -1 ? -1 : lines.length - 1 - idx;

  const clean = (at === -1 ? lines : lines.slice(0, at)).join('\n').trim();
  const fallback: AiVerdict = {
    text: clean, confidence: 'medium', intent: null, skill: null, priority: 'normal', summary: null,
  };
  if (at === -1) return fallback;

  const json = lines[at].trim().slice(MARK.length).trim();
  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return fallback; // метку испортили — ответ всё равно годный
  }

  const confidence = CONFIDENCE.includes(meta.confidence as Confidence)
    ? (meta.confidence as Confidence) : 'medium';
  const priority = PRIORITY.includes(meta.priority as Priority)
    ? (meta.priority as Priority) : 'normal';
  return {
    text: clean,
    confidence,
    intent: clip(meta.intent, 48),
    skill: clip(meta.skill, 48),
    priority,
    summary: clip(meta.summary, 500),
  };
}

/**
 * Что сказать человеку, когда надёжного ответа нет.
 *
 * Не «произошла ошибка» и не догадка с оговорками: честная фраза и передача человеку.
 * Внутреннюю причину (низкая уверенность, сбой модели) клиенту не показываем — ему от
 * неё ни холодно ни жарко (02_ANTHILLBOT §15).
 */
export const NO_ANSWER_PHRASE =
  'Не смог надёжно определить причину. Передаю разговор специалисту — повторять ничего не нужно.';

/**
 * Приписка к неуверенному ответу.
 *
 * Средняя уверенность — это «скорее всего так»: ответ даём, но дверь к человеку
 * держим открытой в том же сообщении, а не ждём, пока человек догадается искать кнопку.
 */
export const MAYBE_SUFFIX =
  '\n\nЕсли не помогло — нажмите «Позвать человека», подключим специалиста.';
