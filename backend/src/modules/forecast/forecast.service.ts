import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { VelocityRepository } from '../velocity/velocity.repository';
import { computeForecast, computeOverload } from './forecast.calculator';
import { ForecastRepository } from './forecast.repository';
import { IntegrationOutboxService } from '../integrations/outbox/integration-outbox.service';

const DAY_MS = 86_400_000;

@Injectable()
export class ForecastService {
  constructor(
    private readonly repo: ForecastRepository,
    private readonly velocity: VelocityRepository,
    private readonly realtime: RealtimeService,
    private readonly outbox: IntegrationOutboxService,
  ) {}

  /** Детерминированный пересчёт прогноза/риска задачи + эмиссия task.risk_changed (internal). */
  async recomputeTask(tenantId: string, taskId: string) {
    const task = await this.repo.getTask(tenantId, taskId);
    if (!task) return null;

    if (!task.assignee_id) {
      await this.repo.writeForecast(tenantId, taskId, null, null, 'green');
      return { taskId, predictedFinish: null, riskPct: null, level: 'green' as const };
    }

    const estimate = Number(task.estimate_hours ?? 0);
    const queueAhead = await this.velocity.openQueueHours(tenantId, task.assignee_id, taskId);
    const weekly = Number((await this.velocity.weeklyCapacity(tenantId, task.assignee_id))?.weekly_capacity_hours ?? 40);
    const now = new Date();
    const absenceDaysAhead = await this.velocity.absenceDays(tenantId, task.assignee_id, now, new Date(now.getTime() + 30 * DAY_MS));

    const f = computeForecast({
      estimateHours: estimate,
      queueAheadHours: queueAhead,
      weeklyCapacityHours: weekly,
      absenceDaysAhead,
      deadline: task.deadline_at ? new Date(task.deadline_at) : null,
      now,
    });

    await this.repo.writeForecast(tenantId, taskId, f.predictedFinish, f.riskPct, f.level);
    this.realtime.emitInternal(tenantId, task.project_id, 'task.risk_changed', {
      id: taskId,
      project_id: task.project_id,
      predicted_finish_at: f.predictedFinish,
      risk_pct: f.riskPct,
      risk_level: f.level,
    });
    return { taskId, predictedFinish: f.predictedFinish, riskPct: f.riskPct, level: f.level };
  }

  /** Назначение с синхронным guard перегруза (Шаг 4.3). */
  async assign(tenantId: string, taskId: string, assigneeId: string, actorId: string, confirmOverload: boolean) {
    const task = await this.repo.getTask(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');

    const estimate = Number(task.estimate_hours ?? 0);
    const currentQueue = await this.velocity.openQueueHours(tenantId, assigneeId, taskId);
    const weekly = Number((await this.velocity.weeklyCapacity(tenantId, assigneeId))?.weekly_capacity_hours ?? 40);
    const now = new Date();
    const absence = await this.velocity.absenceDays(tenantId, assigneeId, now, new Date(now.getTime() + 30 * DAY_MS));
    const threshold = await this.repo.tenantRiskThreshold(tenantId);

    const f = computeForecast({
      estimateHours: estimate,
      queueAheadHours: currentQueue,
      weeklyCapacityHours: weekly,
      absenceDaysAhead: absence,
      deadline: task.deadline_at ? new Date(task.deadline_at) : null,
      now,
    });
    const overload = computeOverload({
      currentQueueHours: currentQueue,
      newEstimateHours: estimate,
      weeklyCapacityHours: weekly,
      riskPct: f.riskPct,
      threshold,
    });

    if (overload.warn && !confirmOverload) {
      this.realtime.emitInternal(tenantId, task.project_id, 'overload.warned', {
        taskId,
        assigneeId,
        riskPct: f.riskPct,
        projectedHours: overload.projectedHours,
        capacityHours: overload.capacityHours,
      });
      return {
        assigned: false,
        warning: true,
        riskPct: f.riskPct,
        riskLevel: f.level,
        projectedHours: overload.projectedHours,
        capacityHours: overload.capacityHours,
        reasons: overload.reasons,
        hint: 'передайте confirm_overload=true для принудительного назначения',
      };
    }

    await this.repo.assign(tenantId, taskId, assigneeId);
    await this.repo.auditAssignment({
      tenantId,
      taskId,
      assigneeId,
      actorId,
      riskPct: f.riskPct,
      overloadConfirmed: overload.warn && confirmOverload,
    });
    await this.outbox.enqueueForTask(tenantId, taskId, 'task.update'); // исполнитель → во внешнюю систему
    const fc = await this.recomputeTask(tenantId, taskId);
    return { assigned: true, warning: false, overloadConfirmed: overload.warn && confirmOverload, forecast: fc };
  }

  async getForecast(tenantId: string, taskId: string, role: string) {
    const task = await this.repo.getTask(tenantId, taskId);
    if (!task) throw AppException.notFound('Task not found');
    const isClient = role === 'client';
    // client видит честную дату и цвет, но НЕ risk_pct/внутренние метрики (фича №8/№9)
    return {
      taskId,
      predicted_finish_at: task.predicted_finish_at,
      risk_level: task.risk_level,
      ...(isClient ? {} : { risk_pct: task.risk_pct, deadline_at: task.deadline_at }),
    };
  }

  async setEstimateDeadline(
    tenantId: string, taskId: string,
    patch: { estimate?: number | null; deadline?: string | null },
  ) {
    const res = await this.repo.setEstimateDeadline(tenantId, taskId, patch);
    // Снятый срок внешней системе тоже важен: там задача иначе останется просроченной.
    if (patch.deadline !== undefined) await this.outbox.enqueueForTask(tenantId, taskId, 'task.update');
    return res;
  }
}
