import { Injectable } from '@nestjs/common';
import { DecisionQueueRepository } from './decision-queue.repository';
import { decisionsPassport, oldestFirst, queueStats, QueueItem } from './decision-queue.rules';

type Viewer = { tenantId: string; userId: string };

/**
 * «Ждут вашего решения» — ОДНА функция на все экраны (#4890, п. 3 и 13): брифинг ИИ,
 * счётчик Фокуса, бейдж меню, Пульс команды и «Пульс недели» берут число отсюда. Хотите
 * поменять определение — меняйте здесь (и в DecisionQueueRepository.items), а не на экране.
 */
@Injectable()
export class DecisionQueueService {
  constructor(private readonly repo: DecisionQueueRepository) {}

  /** Очередь целиком, самые старые первыми. */
  async items(v: Viewer): Promise<QueueItem[]> {
    return (await this.repo.items(v.tenantId, v.userId)).sort(oldestFirst);
  }

  /** Число и сводка в один момент времени: count — ровно длина списка items. */
  async waiting(v: Viewer, now = new Date()) {
    const items = await this.items(v);
    return { ...queueStats(items, now), reviews: items.filter((i) => i.kind === 'review').length, approvals: items.filter((i) => i.kind === 'approval').length, items, updatedAt: now };
  }

  async count(v: Viewer): Promise<number> {
    return (await this.repo.items(v.tenantId, v.userId)).length;
  }

  team(tenantId: string) { return this.repo.team(tenantId); }
  teamTotal(tenantId: string) { return this.repo.teamTotal(tenantId); }

  async passport(v: Viewer) {
    const now = new Date();
    const [w, team] = await Promise.all([this.waiting(v, now), this.repo.teamTotal(v.tenantId)]);
    return decisionsPassport({
      count: w.count, reviews: w.reviews, approvals: w.approvals, overdue: w.overdue, teamReview: team,
      projects: w.projects.length, updatedAt: now,
    });
  }
}
