/**
 * Где кончается разговор (ТЗ-12, разд. 8).
 *
 * Смысл переписки складывается к её концу. «Юра, сделай форму до пятницы» в 10:00 и
 * «нет, пока не делай» в 10:10 — это один разговор с одним итогом, и разбирать их по
 * отдельности значит завести задачу, которую тут же отменили. Поэтому разбираем не
 * сообщения, а ЗАТИХШИЕ отрезки: те, после которых прошло достаточно тишины.
 *
 * Живой хвост переписки не отдаём вовсе — он ещё не закончился. Он дождётся следующего
 * прохода, а если так и не затихнет до ночи, его возьмёт суточная сверка (этап 8).
 *
 * Чистые функции; проверяются юнит-тестом рядом.
 */

export interface SegmentMessage {
  id: string;
  createdAt: Date;
  /** Автор: у сообщения бота его нет. */
  authorId: string | null;
  isAi: boolean;
}

export interface Segment {
  startId: string;
  endId: string;
  startedAt: Date;
  endedAt: Date;
  /** Сколько всего сообщений вошло, включая служебные. */
  count: number;
}

/**
 * Сколько сообщений максимум уходит в один разбор.
 *
 * Не ради экономии: длинный разговор в одном запросе разбирается хуже — модель теряет
 * начало. Длинную переписку режем на части по порядку, и каждая разбирается сама.
 */
export const MAX_SEGMENT_MESSAGES = 120;

const human = (m: SegmentMessage): boolean => !m.isAi && !!m.authorId;

/**
 * Разбить сообщения на затихшие отрезки.
 *
 * `messages` — по возрастанию id, уже только новые (после отметки «докуда разобрано»).
 * Отрезок закрывается, когда до следующего сообщения прошло больше `quietMs`, — или
 * когда сообщений больше нет, а с последнего прошло столько же.
 *
 * Отрезки без единого человеческого сообщения отбрасываем: разбирать ленту бота не за
 * чем, а стоить это будет столько же.
 */
export function closedSegments(messages: SegmentMessage[], quietMs: number, now: Date): Segment[] {
  const out: Segment[] = [];
  let bunch: SegmentMessage[] = [];

  const close = () => {
    if (bunch.length && bunch.some(human)) {
      out.push({
        startId: bunch[0].id,
        endId: bunch[bunch.length - 1].id,
        startedAt: bunch[0].createdAt,
        endedAt: bunch[bunch.length - 1].createdAt,
        count: bunch.length,
      });
    }
    bunch = [];
  };

  for (let i = 0; i < messages.length; i++) {
    bunch.push(messages[i]);
    const next = messages[i + 1];
    // Тишина после этого сообщения: до следующего, а для последнего — до «сейчас».
    const gap = (next ? next.createdAt.getTime() : now.getTime()) - messages[i].createdAt.getTime();

    if (!next) {
      // Хвост разговора отдаём, только если он ДЕЙСТВИТЕЛЬНО затих.
      if (gap >= quietMs) close();
      else bunch = [];
      break;
    }
    if (gap >= quietMs || bunch.length >= MAX_SEGMENT_MESSAGES) close();
  }

  return out;
}
