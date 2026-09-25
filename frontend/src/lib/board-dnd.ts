/**
 * Перенос на доске: что чем перетаскивают и как лента колонок едет за курсором.
 *
 * Отдельным файлом, потому что это единственная часть переноса, которую можно
 * проверить без браузера, — и та, где легче всего ошибиться: лента должна ехать
 * плавно, останавливаться у края и не дёргаться, когда ехать уже некуда.
 */

/** Перетаскивают колонку целиком. */
export const COL_DND = 'application/x-teamcrm-column';

/**
 * Перетаскивают карточку задачи.
 *
 * Сам номер задачи по-прежнему едет в `text/plain` — его читают обработчики сброса, и
 * ломать их незачем. Но по `text/plain` нельзя отличить свою карточку от куска текста,
 * выделенного на странице, а лента колонок обязана ехать только за своими переносами.
 */
export const TASK_DND = 'application/x-teamcrm-task';

/** Это наш перенос — карточка или колонка? Значения при перетаскивании не видны, типы видны. */
export function isBoardDrag(data: DataTransfer | null): boolean {
  if (!data) return false;
  return data.types.includes(TASK_DND) || data.types.includes(COL_DND);
}

export interface EdgeScrollInput {
  /** Где сейчас указатель (координата в окне). */
  pointer: number;
  /** Края ленты в тех же координатах. */
  start: number;
  end: number;
  /** Насколько лента уже прокручена и сколько всего можно прокрутить. */
  scroll: number;
  maxScroll: number;
  /** Ширина чувствительной полосы у края. */
  zone?: number;
  /** Скорость у самого края, пикселей за кадр. */
  maxSpeed?: number;
}

/**
 * На сколько сдвинуть ленту за один кадр. Минус — влево, плюс — вправо, ноль — стоим.
 *
 * Скорость растёт от нуля на внутренней границе полосы до наибольшей у самого края:
 * так у человека остаётся точное управление рядом с крайней колонкой и быстрый ход,
 * когда нужная доска далеко. За краем окна (указатель ушёл дальше края ленты) едем на
 * полной скорости — именно этого и ждут, утаскивая карточку «за экран».
 *
 * Дальше конца ленты не уезжаем: остаток возвращается как есть, поэтому последний кадр
 * доводит ровно до края и следующий даёт ноль. Без этого лента упиралась бы в край с
 * ненулевой скоростью, и подсветка колонки мигала бы на каждом кадре.
 */
export function edgeScrollStep(input: EdgeScrollInput): number {
  const zone = input.zone ?? 96;
  const maxSpeed = input.maxSpeed ?? 20;
  const { pointer, start, end, scroll, maxScroll } = input;

  let speed = 0;
  if (pointer < start + zone) speed = -maxSpeed * depth(start + zone - pointer, zone);
  else if (pointer > end - zone) speed = maxSpeed * depth(pointer - (end - zone), zone);

  // `|| 0` убирает «минус ноль»: на вид он ноль, но сравнения его таковым не считают.
  if (speed < 0) return -Math.min(-speed, Math.max(0, scroll)) || 0;
  if (speed > 0) return Math.min(speed, Math.max(0, maxScroll - scroll));
  return 0;
}

/** Насколько глубоко указатель зашёл в полосу: от 0 на её границе до 1 у края и дальше. */
function depth(inside: number, zone: number): number {
  return Math.min(1, inside / zone);
}
