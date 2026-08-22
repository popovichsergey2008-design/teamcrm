import { Injectable } from '@nestjs/common';
import { NavRepository } from './nav.repository';
import { endOfLocalDay } from '../../common/time/local-day';

export type NavCounters = {
  focus: { decide: number; today: number };
  /** null у тех, кому «Пульс команды» не показывается: считать общий счётчик незачем */
  radar: { risks: number } | null;
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
  constructor(private readonly repo: NavRepository) {}

  async counters(tenantId: string, userId: string, role: string, tzOffsetMin: number): Promise<NavCounters> {
    const withRisks = role === 'owner' || role === 'manager';
    const row = await this.repo.counts(tenantId, userId, endOfLocalDay(tzOffsetMin), withRisks);
    return {
      focus: { decide: row?.decide ?? 0, today: row?.today ?? 0 },
      radar: withRisks ? { risks: row?.risks ?? 0 } : null,
    };
  }
}
