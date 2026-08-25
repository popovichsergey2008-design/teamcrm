import { Injectable } from '@nestjs/common';
import { RadarRepository } from './radar.repository';
import { endOfLocalDay } from '../../common/time/local-day';

/**
 * Через сколько часов без движения задача на проверке считается зависшей.
 *
 * Значение по умолчанию: сутки. Раньше стояло двое, и для команд, где проверяют
 * в тот же день, экран «Узкие места» молчал ровно тогда, когда уже стоило смотреть.
 * Кому двое суток ближе — меняет порог в личном кабинете; это личная настройка
 * того, кто смотрит «Пульс», а не общее правило организации.
 */
export const DEFAULT_STUCK_HOURS = 24;
const MIN_STUCK_HOURS = 1;
const MAX_STUCK_HOURS = 168;

/**
 * Порог из настройки — в рабочее число часов.
 *
 * Слишком большое значение правим по границе: экран руководителя важнее придирки к числу.
 * А вот всё, что меньше часа, — ноль, минус, дробь, мусор, — это НЕ «показывать всё
 * подряд», а «настройки нет»: сутки. Подтягивать такое к минимуму значило бы завалить
 * «Узкие места» задачами, которые сдали пять минут назад.
 */
export function stuckHoursFrom(raw: number | null | undefined): number {
  if (raw === null || raw === undefined || !Number.isFinite(raw)) return DEFAULT_STUCK_HOURS;
  const hours = Math.round(Number(raw));
  if (hours < MIN_STUCK_HOURS) return DEFAULT_STUCK_HOURS;
  return Math.min(hours, MAX_STUCK_HOURS);
}

@Injectable()
export class RadarService {
  constructor(private readonly repo: RadarRepository) {}

  /**
   * Сводка для «Пульса команды».
   *
   * Четыре независимых выборки вместо одного запроса: у них разная форма ответа,
   * а экран открывают несколько раз в день, не постоянно. Считать всё вместе ради
   * экономии одного похода в базу — усложнение без выигрыша.
   *
   * Предиктивной части («вероятность срыва 85%») здесь намеренно нет: она требует
   * истории и оценок, а выдуманный процент на экране руководителя опаснее его отсутствия.
   */
  async overview(tenantId: string, userId: string, tzOffsetMin: number) {
    const hours = stuckHoursFrom(await this.repo.stuckHoursOf(tenantId, userId));
    const [projects, people, stuck, velocity] = await Promise.all([
      this.repo.projects(tenantId),
      this.repo.people(tenantId, endOfLocalDay(tzOffsetMin)),
      this.repo.stuck(tenantId, hours),
      this.repo.velocity(tenantId),
    ]);

    return {
      projects,
      people,
      stuck,
      stuckHours: hours,
      velocity: { last7: velocity?.last7 ?? 0, prev7: velocity?.prev7 ?? 0 },
    };
  }
}
