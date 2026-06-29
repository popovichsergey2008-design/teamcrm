import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { RedisService } from '../../cache/redis.service';
import { RealtimeService } from '../realtime/realtime.service';
import { AppException } from '../../common/http/app-exception';
import { computeMargin, computeTaskCost } from './cost.calculator';
import { EconomicsRepository, ProjectPnl } from './economics.repository';
import { EconomicsMessage } from './economics.types';

const PNL_TTL = 60; // сек

@Injectable()
export class EconomicsService {
  private readonly logger = new Logger('Economics');

  constructor(
    private readonly db: DbService,
    private readonly repo: EconomicsRepository,
    private readonly redis: RedisService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Обработчик сообщения очереди economics (идемпотентный полный пересчёт). */
  async handle(msg: EconomicsMessage): Promise<void> {
    switch (msg.kind) {
      case 'recompute_task':
        if (msg.taskId) await this.recomputeTask(msg.tenantId, msg.taskId);
        break;
      case 'recompute_project':
        if (msg.projectId) await this.recomputeProject(msg.tenantId, msg.projectId);
        break;
      case 'recompute_on_rate_change':
        if (msg.userId) {
          const taskIds = await this.repo.taskIdsByUser(msg.tenantId, msg.userId);
          for (const id of taskIds) await this.recomputeTask(msg.tenantId, id);
        }
        break;
    }
  }

  async recomputeProject(tenantId: string, projectId: string): Promise<void> {
    const taskIds = await this.repo.taskIdsByProject(tenantId, projectId);
    for (const id of taskIds) await this.recomputeTask(tenantId, id);
    if (taskIds.length === 0) {
      // проект без задач — всё равно обновим агрегат (cost=0)
      await this.applyProjectRecompute(tenantId, projectId, null);
    }
  }

  /** Полный пересчёт одной задачи + агрегатов проекта + алертов, транзакционно. */
  async recomputeTask(tenantId: string, taskId: string): Promise<void> {
    const tp = await this.repo.getTaskProject(tenantId, taskId);
    if (!tp) return;
    const projectId = tp.project_id;

    const logs = await this.repo.timeLogsForTask(tenantId, taskId);
    const userIds = [...new Set(logs.map((l) => l.userId))];
    const rates = await this.repo.ratesForUsers(tenantId, userIds);
    const cost = computeTaskCost(logs, rates, new Date());

    await this.applyProjectRecompute(tenantId, projectId, { taskId, cost });
  }

  /**
   * Транзакция записи: cost задачи (если задана) → агрегаты проекта → алерт.
   * После commit — realtime-события (только internal) и кэш P&L.
   */
  private async applyProjectRecompute(
    tenantId: string,
    projectId: string,
    task: { taskId: string; cost: number } | null,
  ): Promise<void> {
    const result = await this.db.withTransaction(async (client) => {
      if (task) await this.repo.setTaskCost(client, tenantId, task.taskId, task.cost);
      const pnl = await this.repo.recomputeProjectAggregate(client, tenantId, projectId);

      let alertRaised = false;
      let alertResolved = false;
      const below =
        pnl.marginActual !== null &&
        pnl.marginThreshold !== null &&
        pnl.marginActual < pnl.marginThreshold;
      if (below) {
        alertRaised = await this.repo.raiseMarginAlert(client, tenantId, projectId, {
          budget: pnl.budget,
          cost: pnl.costActual,
          margin: pnl.marginActual,
          threshold: pnl.marginThreshold,
        });
      } else {
        alertResolved = await this.repo.resolveMarginAlert(client, tenantId, projectId);
      }
      return { pnl, alertRaised, alertResolved };
    });

    await this.afterCommit(tenantId, projectId, task, result);
  }

  private async afterCommit(
    tenantId: string,
    projectId: string,
    task: { taskId: string; cost: number } | null,
    result: { pnl: ProjectPnl; alertRaised: boolean; alertResolved: boolean },
  ) {
    const { pnl, alertRaised, alertResolved } = result;
    const pnlView = {
      projectId,
      budget: pnl.budget,
      costActual: pnl.costActual,
      marginActual: pnl.marginActual,
      plannedMargin: pnl.plannedMargin,
      marginThreshold: pnl.marginThreshold,
      marginDelta:
        pnl.marginActual !== null && pnl.plannedMargin !== null
          ? Math.round((pnl.marginActual - pnl.plannedMargin) * 100) / 100
          : null,
    };

    // кэш P&L (восстановим из PG при промахе)
    await this.redis.setJson(`pnl:${tenantId}:${projectId}`, pnlView, PNL_TTL).catch(() => undefined);

    // финансовые события — только internal-комната (фича №9)
    if (task) {
      this.realtime.emitInternal(tenantId, projectId, 'task.cost_changed', {
        id: task.taskId,
        project_id: projectId,
        cost_current: task.cost.toFixed(2),
      });
    }
    this.realtime.emitInternal(tenantId, projectId, 'project.pnl_changed', pnlView);

    if (alertRaised) {
      this.realtime.emitInternal(tenantId, projectId, 'alert.raised', {
        type: 'margin_below_threshold',
        projectId,
        margin: pnl.marginActual,
        threshold: pnl.marginThreshold,
      });
      this.logger.warn(`alert raised: project ${projectId} margin ${pnl.marginActual}% < ${pnl.marginThreshold}%`);
    }
    if (alertResolved) {
      this.realtime.emitInternal(tenantId, projectId, 'alert.resolved', {
        type: 'margin_below_threshold',
        projectId,
        margin: pnl.marginActual,
      });
    }
  }

  // ---- read-side (дашборды) ----

  async getTaskCost(tenantId: string, taskId: string) {
    const row = await this.repo.getTaskCost(tenantId, taskId);
    if (!row) throw AppException.notFound('Task not found');
    return { taskId: row.id, costCurrent: row.cost_current };
  }

  /** P&L проекта: cache-first (Redis), иначе из PostgreSQL (восстановимо). */
  async getProjectPnl(tenantId: string, projectId: string) {
    const cached = await this.redis.getJson(`pnl:${tenantId}:${projectId}`).catch(() => null);
    if (cached) return cached;

    const row: any = await this.repo.getProjectPnlRow(tenantId, projectId);
    if (!row) throw AppException.notFound('Project not found');
    const budget = row.budget !== null ? Number(row.budget) : null;
    const costActual = Number(row.cost_actual);
    const marginActual = row.margin_actual !== null ? Number(row.margin_actual) : null;
    const plannedMargin = row.planned_margin !== null ? Number(row.planned_margin) : null;
    const view = {
      projectId,
      budget,
      costActual,
      marginActual,
      plannedMargin,
      marginDelta:
        marginActual !== null && plannedMargin !== null
          ? Math.round((marginActual - plannedMargin) * 100) / 100
          : null,
      recomputedAt: row.economics_recomputed_at,
    };
    await this.redis.setJson(`pnl:${tenantId}:${projectId}`, view, PNL_TTL).catch(() => undefined);
    return view;
  }

  /** Таймлайн себестоимости/маржи по дням (дашборд). Использует тот же калькулятор. */
  async getTimeline(tenantId: string, projectId: string, maxDays = 60) {
    const row: any = await this.repo.getProjectPnlRow(tenantId, projectId);
    if (!row) throw AppException.notFound('Project not found');
    const budget = row.budget !== null ? Number(row.budget) : null;

    const logs = await this.repo.projectTimeLogs(tenantId, projectId);
    if (logs.length === 0) return { projectId, points: [] };
    const userIds = [...new Set(logs.map((l) => l.userId))];
    const rates = await this.repo.ratesForUsers(tenantId, userIds);

    const first = logs.reduce((m, l) => (l.start < m ? l.start : m), logs[0].start);
    const startDay = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), first.getUTCDate()));
    const today = new Date();
    const points: Array<{ date: string; cost: number; margin: number | null }> = [];

    const dayMs = 86_400_000;
    const days = Math.min(maxDays, Math.floor((today.getTime() - startDay.getTime()) / dayMs) + 1);
    const startOffset = Math.max(0, Math.floor((today.getTime() - startDay.getTime()) / dayMs) - days + 1);

    for (let i = 0; i < days; i++) {
      const cutoff = new Date(startDay.getTime() + (startOffset + i + 1) * dayMs); // конец дня
      const cost = computeTaskCost(logs, rates, cutoff > today ? today : cutoff);
      points.push({
        date: new Date(startDay.getTime() + (startOffset + i) * dayMs).toISOString().slice(0, 10),
        cost,
        margin: computeMargin(budget, cost),
      });
    }
    return { projectId, points };
  }
}
