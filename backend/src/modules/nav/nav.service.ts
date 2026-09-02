import { Injectable } from '@nestjs/common';
import { NavRepository } from './nav.repository';
import { ApprovalsRepository } from '../approvals/approvals.repository';
import { CalendarRepository } from '../calendar/calendar.repository';
import { endOfLocalDay } from '../../common/time/local-day';
import { TaskReadsRepository } from '../tasks/task-reads.repository';

export type NavCounters = {
  focus: { decide: number; today: number };
  /** Приглашения на встречи, на которые человек ещё не ответил. */
  calendar: { pending: number };
  /** null у тех, кому «Пульс команды» не показывается: считать общий счётчик незачем */
  radar: { risks: number } | null;
  /** Новое в моих задачах: чужие изменения, которых я ещё не видел. */
  tasks: { unread: number };
};

/**
 * Счётчики левой панели.
 *
 * Кэша здесь намеренно нет, хотя в плане он был. Бейдж обязан реагировать на
 * СВОИ действия сразу: принял задачу — счётчик упал. Кэш на 30 секунд превращал бы
 * это в «нажал, а цифра висит», и человек жмёт ещё раз. Цена отказа невелика:
 * запрос — три счётчика по тем же индексам, что и списки задач, а клиент ходит
 * за ними не чаще раза в 10 секунд.
 */
@Injectable()
export class NavService {
  constructor(
    private readonly repo: NavRepository,
    private readonly approvals: ApprovalsRepository,
    private readonly calendar: CalendarRepository,
    private readonly reads: TaskReadsRepository,
  ) {}

  async counters(tenantId: string, userId: string, role: string, tzOffsetMin: number): Promise<NavCounters> {
    const withRisks = role === 'owner' || role === 'manager';
    // «Требует решения» — это и сданные работы, и согласования: для человека
    // это один и тот же вопрос «что ждёт лично меня», разделять его в бейдже незачем.
    const [row, approvals, invites, unread] = await Promise.all([
      this.repo.counts(tenantId, userId, endOfLocalDay(tzOffsetMin), withRisks),
      this.approvals.pendingCount(tenantId, userId),
      // календарь стал разделом панели: неотвеченное приглашение должно быть видно
      // там же, где всё остальное, а не только внутри самого календаря
      this.calendar.pendingCount(tenantId, userId).catch(() => 0),
      // «в проектах что-то произошло» — то же самое, что непрочитанное в чатах,
      // только про задачи: чужие изменения, до которых я ещё не дошёл
      this.reads.total(tenantId, userId).catch(() => 0),
    ]);
    return {
      focus: { decide: (row?.decide ?? 0) + (approvals?.n ?? 0), today: row?.today ?? 0 },
      calendar: { pending: invites },
      radar: withRisks ? { risks: row?.risks ?? 0 } : null,
      tasks: { unread },
    };
  }
}
