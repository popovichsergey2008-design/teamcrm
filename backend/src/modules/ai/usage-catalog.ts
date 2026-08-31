/**
 * Где система обращается к ИИ — полный список, а не только то, что уже сработало.
 *
 * Вопрос, ради которого это написано, звучал так: «кажется, ИИ вызывается не везде».
 * Отчёт, показывающий одни израсходованные токены, на него не отвечает: в нём не видно
 * разницы между «здесь ИИ не нужен» и «здесь он должен был сработать, но не сработал».
 * Поэтому показываем ВСЕ места, где вызов заложен, и рядом — сколько раз он случился.
 * Ноль напротив строки — такой же ответ, как тысяча.
 */

export interface FeatureInfo {
  /** Ключ из `ai_usage.feature`. */
  key: string;
  title: string;
  /** Откуда в интерфейсе это запускается — чтобы цифру можно было проверить руками. */
  where: string;
  /** Группа для чтения отчёта: работа с задачами, встречи, знания, служебное. */
  group: 'tasks' | 'meetings' | 'knowledge' | 'service';
}

export const AI_FEATURES: FeatureInfo[] = [
  { key: 'nl_command', title: 'Постановка задачи текстом и голосом', where: 'Быстрая команда, микрофон в панели', group: 'tasks' },
  { key: 'nl_event', title: 'Встреча из надиктовки', where: 'Календарь → создать голосом', group: 'tasks' },
  { key: 'agent_task_draft', title: 'ИИ-агент: черновик решения', where: 'Карточка задачи → ИИ-агент', group: 'tasks' },
  { key: 'agent_task_execute', title: 'ИИ-агент: выполнение задачи', where: 'Карточка задачи → ИИ-агент', group: 'tasks' },
  { key: 'agent_task_rework', title: 'ИИ-агент: доработка по замечаниям', where: 'Карточка задачи → ИИ-агент', group: 'tasks' },
  { key: 'inbox_draft', title: 'Черновик задачи из входящего письма', where: 'Входящие', group: 'tasks' },

  { key: 'meeting_transcribe', title: 'Расшифровка записи встречи', where: 'Встречи → загрузка записи', group: 'meetings' },
  { key: 'meeting_analyze', title: 'Разбор встречи: сводка и задачи', where: 'Встречи → после расшифровки', group: 'meetings' },
  { key: 'meeting_agenda', title: 'Повестка перед встречей', where: 'Секретарь, за 5 минут до начала', group: 'meetings' },
  { key: 'standup_parse', title: 'Разбор дейлика из Telegram', where: 'Бот @teamsmrt_bot', group: 'meetings' },

  { key: 'brain', title: 'Ответы по базе знаний', where: 'Поиск по смыслу, вопросы к базе', group: 'knowledge' },
  { key: 'embedding', title: 'Индексация задач и документов', where: 'Фоном, при изменении данных', group: 'knowledge' },
  { key: 'knowledge_summary', title: 'Сводка по документу', where: 'База знаний', group: 'knowledge' },

  { key: 'bitrix_route', title: 'Разбор импорта из Битрикс24', where: 'Интеграции → Битрикс24', group: 'service' },
  { key: 'promptops_optimize', title: 'Улучшение промптов', where: 'Интеграции → библиотека промптов', group: 'service' },
];

const BY_KEY = new Map(AI_FEATURES.map((f) => [f.key, f]));

/** Неизвестный ключ — не повод прятать расход: показываем как есть. */
export function describeFeature(key: string): FeatureInfo {
  return BY_KEY.get(key) ?? { key, title: key, where: '—', group: 'service' };
}

/**
 * Цена вызова.
 *
 * В базе `cost_estimate` заполняется только для расшифровки (она тарифицируется по
 * минутам звука). Для текстовых моделей там нули — цену считаем здесь, по числу
 * токенов, иначе отчёт о расходах показывал бы «0 ₽» при миллионах токенов.
 *
 * Цены — в долларах за миллион токенов, по публичным прайсам на август 2026.
 * Бесплатные модели OpenRouter стоят ноль честно, а не по недосмотру.
 */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /^gpt-4o-mini/, input: 0.15, output: 0.6 },
  { match: /^gpt-4o/, input: 2.5, output: 10 },
  { match: /^gpt-4\.1-mini/, input: 0.4, output: 1.6 },
  { match: /^gpt-4\.1/, input: 2, output: 8 },
  { match: /^text-embedding-3-small/, input: 0.02, output: 0 },
  { match: /^text-embedding-3-large/, input: 0.13, output: 0 },
  { match: /^claude-haiku/, input: 1, output: 5 },
  { match: /^claude-3-5-sonnet|^claude-sonnet/, input: 3, output: 15 },
  { match: /^claude-opus/, input: 15, output: 75 },
  { match: /:free$/, input: 0, output: 0 },
];

export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const price = PRICES.find((p) => p.match.test(model));
  if (!price) return 0;
  const usd = (inputTokens / 1_000_000) * price.input + (outputTokens / 1_000_000) * price.output;
  return Number(usd.toFixed(4));
}

/**
 * Настоящий это ИИ или заглушка.
 *
 * Без ключа система работает на встроенном моке — конвейер живёт, но думает не модель.
 * В отчёте это надо видеть отдельно: «сработало 40 раз» и «сработало 40 раз вхолостую»
 * — разные новости, и именно вторая объясняет ощущение «ИИ будто не работает».
 */
export function isMockModel(model: string): boolean {
  return model.startsWith('mock');
}
