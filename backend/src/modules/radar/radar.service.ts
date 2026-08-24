import { Injectable } from '@nestjs/common';
import { RadarRepository } from './radar.repository';
import { endOfLocalDay } from '../../common/time/local-day';

/** Через сколько часов без движения задача на проверке считается зависшей. */
const STUCK_HOURS = 48;

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
  async overview(tenantId: string, tzOffsetMin: number) {
    const [projects, people, stuck, velocity] = await Promise.all([
      this.repo.projects(tenantId),
      this.repo.people(tenantId, endOfLocalDay(tzOffsetMin)),
      this.repo.stuck(tenantId, STUCK_HOURS),
      this.repo.velocity(tenantId),
    ]);

    return {
      projects,
      people,
      stuck,
      stuckHours: STUCK_HOURS,
      velocity: { last7: velocity?.last7 ?? 0, prev7: velocity?.prev7 ?? 0 },
    };
  }
}
