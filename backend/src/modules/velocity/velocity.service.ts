import { Injectable } from '@nestjs/common';
import { RedisService } from '../../cache/redis.service';
import { capacityHours, computeVelocity } from './velocity.calculator';
import { VelocityRepository } from './velocity.repository';

const WINDOW_DAYS = 90;
const CACHE_TTL = 3600;
const DAY_MS = 86_400_000;

@Injectable()
export class VelocityService {
  constructor(
    private readonly repo: VelocityRepository,
    private readonly redis: RedisService,
  ) {}

  /** Идемпотентный полный пересчёт Velocity за окно. Кэширует для синхронных проверок. */
  async recompute(tenantId: string, userId: string, now = new Date()) {
    const from = new Date(now.getTime() - WINDOW_DAYS * DAY_MS);
    const { closedTasks, trackedHours } = await this.repo.windowStats(tenantId, userId, from, now);
    const velocity = computeVelocity(closedTasks, trackedHours);
    await this.repo.upsertMetric({ tenantId, userId, from, to: now, closedTasks, trackedHours, velocity });

    const view = { userId, velocity, closedTasks, trackedHours, windowDays: WINDOW_DAYS, computedAt: now.toISOString() };
    await this.redis.setJson(`velocity:${tenantId}:${userId}`, view, CACHE_TTL).catch(() => undefined);
    return view;
  }

  /** Velocity из кэша (для синхронного guard); при промахе — пересчёт. */
  async getVelocity(tenantId: string, userId: string) {
    const cached = await this.redis.getJson(`velocity:${tenantId}:${userId}`).catch(() => null);
    if (cached) return cached;
    return this.recompute(tenantId, userId);
  }

  /** Загрузка vs ёмкость (часы за неделю). internal-роли. */
  async getLoad(tenantId: string, userId: string, now = new Date()) {
    const cap = Number((await this.repo.weeklyCapacity(tenantId, userId))?.weekly_capacity_hours ?? 40);
    const to = new Date(now.getTime() + 7 * DAY_MS);
    const absence = await this.repo.absenceDays(tenantId, userId, now, to);
    const effectiveCapacity = capacityHours(cap, 7, absence);
    const queueHours = await this.repo.openQueueHours(tenantId, userId);
    return {
      userId,
      weeklyCapacityHours: cap,
      effectiveCapacityHours: effectiveCapacity,
      queueHours,
      utilizationPct: effectiveCapacity > 0 ? Math.round((queueHours / effectiveCapacity) * 100) : null,
      absenceDaysNextWeek: absence,
    };
  }

  addAvailability(tenantId: string, userId: string, kind: string, fromDate: string, toDate: string) {
    return this.repo.addAvailability(tenantId, userId, kind, fromDate, toDate);
  }
  listAvailability(tenantId: string, userId: string) {
    return this.repo.listAvailability(tenantId, userId);
  }
  listUserIds(tenantId: string) {
    return this.repo.listUserIds(tenantId);
  }
}
