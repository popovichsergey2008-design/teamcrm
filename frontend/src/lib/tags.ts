import type { TagSettings } from './api';

/**
 * Теги задачи в тот момент, когда её ещё создают.
 *
 * `suggested` — что предложил ИИ: по нему видно, какие плашки показать как
 * предложение, и по нему же сервер понимает, что человек поправил. `confirmed` и
 * `confirmedWithoutTags` — разные вещи: «подтвердил вот эти» и «сознательно оставил
 * задачу без тегов». Второе нужно именно как отдельное действие, иначе «тегов нет»
 * невозможно отличить от «интерфейс про теги не спросил».
 */
export interface TagsValue {
  tagIds: string[];
  suggested: string[];
  confirmed: boolean;
  confirmedWithoutTags: boolean;
}

export const EMPTY_TAGS: TagsValue = { tagIds: [], suggested: [], confirmed: false, confirmedWithoutTags: false };

/**
 * Можно ли создавать задачу с такими тегами.
 *
 * Пока компания требует подтверждения, ответ «нет» — до явного решения человека. То
 * же правило проверяет сервер: экран может быть старым, а политика компании — нет.
 */
export function tagsReady(settings: TagSettings | null, value: TagsValue): boolean {
  if (!settings?.aiTagging || !settings.requireConfirmation) return true;
  if (value.confirmedWithoutTags) return true;
  return value.confirmed && value.tagIds.length > 0;
}

/**
 * Подтвердить набор одним действием — для кнопки «подтвердить у всех» в пакете.
 *
 * Пустой набор подтверждается как «без тегов»: это разные решения, и сервер их
 * различает, поэтому различаем и здесь.
 */
export function confirmTags(value: TagsValue): TagsValue {
  return value.tagIds.length > 0
    ? { ...value, confirmed: true, confirmedWithoutTags: false }
    : { ...value, confirmed: false, confirmedWithoutTags: true };
}

/** Сколько черновиков в пакете ещё ждут подтверждения тегов — для кнопки «создать N». */
export function pendingTagCount(settings: TagSettings | null, values: TagsValue[]): number {
  if (!settings?.aiTagging || !settings.requireConfirmation) return 0;
  return values.filter((v) => !tagsReady(settings, v)).length;
}
