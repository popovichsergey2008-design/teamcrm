/**
 * Правила тегов: нормализация имени, поиск дублей, доверие к подсказке ИИ и право
 * заводить новые теги.
 *
 * Вынесено отдельно и без зависимостей — это те решения, которые ошибаются молча:
 * «SEO» и «сео» разойдутся в два тега, подсказка с уверенностью 0.3 встанет в задачу
 * как факт, а сотрудник заведёт сто тегов там, где компания просила ограничить. Здесь
 * они проверяются юнит-тестами, а не глазами на живых данных.
 */

/** Кто вправе заводить новые теги. Значения хранятся в tag_settings.who_can_create. */
export type TagCreatePolicy = 'all' | 'managers' | 'admins';

export interface NamedTag {
  id: string;
  name: string;
  normalized_name?: string | null;
  archived_at?: string | Date | null;
}

/**
 * Имя для сравнения: регистр и лишние пробелы не делают тег другим.
 *
 * `ё` приводим к `е` намеренно: «Учёт» и «Учет» в одном списке — тот же дубль, что и
 * «SEO»/«seo», а набирают их по-разному в зависимости от привычки и клавиатуры.
 */
export function normalizeTagName(name: string): string {
  return String(name ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/ё/g, 'е');
}

/**
 * Похожий тег среди существующих.
 *
 * Похожим считаем совпадение нормализованных имён — и только его. «Умное» сравнение
 * (без окончаний, по расстоянию) даёт ложные срабатывания: «Реклама» и «Рекламация»
 * — разные вещи, а человеку показали бы «такой тег уже есть». Архивные не считаются:
 * их нет в списке выбора, и мешать созданию нового они не должны.
 */
export function findSimilarTag<T extends NamedTag>(name: string, tags: readonly T[]): T | null {
  const key = normalizeTagName(name);
  if (!key) return null;
  return tags.find((t) => !t.archived_at && (t.normalized_name ?? normalizeTagName(t.name)) === key) ?? null;
}

/**
 * Насколько верим подсказке ИИ (ТЗ, п. 28).
 *
 * `sure` — обычная рекомендация; `unsure` — показываем отдельно, «возможно подходит»;
 * `drop` — не показываем вовсе. Нижний порог важнее верхнего: список предложений,
 * наполовину состоящий из мусора, человек перестаёт читать и подтверждает не глядя —
 * а это ровно то, ради чего подтверждение и заводилось.
 */
export type ConfidenceBand = 'sure' | 'unsure' | 'drop';

export function confidenceBand(value: unknown): ConfidenceBand {
  const c = Number(value);
  if (!Number.isFinite(c) || c < 0.5) return 'drop';
  return c >= 0.8 ? 'sure' : 'unsure';
}

/** Может ли человек с такой ролью заводить теги при такой политике компании. */
export function canCreateTag(policy: TagCreatePolicy, role: string): boolean {
  if (role === 'client') return false;
  if (policy === 'admins') return role === 'owner';
  if (policy === 'managers') return role === 'owner' || role === 'manager';
  return true;
}

/**
 * Пройдена ли проверка тегов перед созданием задачи.
 *
 * Если организация требует подтверждения, задача не создаётся, пока постановщик не
 * подтвердил набор тегов либо явно не сказал «без тегов». Разница между «человек
 * решил, что тегов не нужно» и «интерфейс забыл про теги» — принципиальная: во втором
 * случае классификация тихо разваливается, и через месяц фильтровать нечего.
 *
 * Проверка касается только клиентов, которые о тегах ЗНАЮТ, — то есть присылают хоть
 * одно поле о них. Причина простая: правило появилось сегодня, а установленное на
 * телефонах приложение, импорты и интеграции о нём не слышали, и запрет ломал бы им
 * постановку задач вовсе. Наш интерфейс поля присылает всегда, поэтому для живых
 * людей правило работает в полную силу и обойти его подменой запроса не выйдет.
 */
export function tagsGatePassed(
  policy: { aiTagging: boolean; requireConfirmation: boolean },
  input: { tagIds?: unknown[]; confirmed?: boolean; confirmedWithoutTags?: boolean },
): boolean {
  if (!policy.aiTagging || !policy.requireConfirmation) return true;
  // Клиент вообще ничего не сказал о тегах — он их не умеет; не мешаем ему работать.
  const aware = input.tagIds !== undefined || input.confirmed !== undefined || input.confirmedWithoutTags !== undefined;
  if (!aware) return true;
  if (input.confirmedWithoutTags === true) return true;
  const chosen = Array.isArray(input.tagIds) ? input.tagIds.filter(Boolean) : [];
  return input.confirmed === true && chosen.length > 0;
}
