import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { RealtimeService } from '../realtime/realtime.service';
import { VelocityRepository } from '../velocity/velocity.repository';
import { ForecastService } from '../forecast/forecast.service';
import { maskPII } from '../ai/pii';
import { RecommendationsRepository, RecommendationRow } from './recommendations.repository';

/**
 * Проактивный co-pilot (Шаг 4.4). Рекомендация — ПРЕДЛОЖЕНИЕ, не авто-действие.
 * Генерация детерминированная/mock (аналитический LLM-тир — при наличии ключей).
 * Принятие выполняется через те же guarded-пути (forecast.assign).
 */
@Injectable()
export class CopilotService {
  constructor(
    private readonly repo: RecommendationsRepository,
    private readonly velocity: VelocityRepository,
    private readonly forecast: ForecastService,
    private readonly realtime: RealtimeService,
  ) {}

  /** Скан условий → генерация рекомендаций-предложений. */
  async scan(tenantId: string): Promise<RecommendationRow[]> {
    const created: RecommendationRow[] = [];

    // 1) reassign: перегруженные (red) задачи → предложить наименее загруженного исполнителя
    const redTasks = await this.repo.redAssignedTasks(tenantId);
    const userIds = (await this.velocity.listUserIds(tenantId)).map((u) => u.id);
    for (const t of redTasks) {
      if (await this.repo.pendingExists(tenantId, 'reassign', t.id, null)) continue;
      const candidate = await this.leastLoaded(tenantId, userIds, t.assignee_id);
      if (!candidate) continue;
      const rec = await this.repo.create({
        tenantId,
        type: 'reassign',
        projectId: t.project_id,
        taskId: t.id,
        isFinancial: false,
        payload: { taskId: t.id, fromAssigneeId: t.assignee_id, toAssigneeId: candidate, reason: 'исполнитель перегружен (red)' },
      });
      created.push(rec);
      this.realtime.emitInternal(tenantId, t.project_id, 'recommendation.raised', { id: rec.id, type: 'reassign', taskId: t.id });
    }

    // 2) deal_at_risk: проект с активным алертом маржи → финансовая рекомендация (только internal)
    const riskyProjects = await this.repo.activeMarginAlertProjects(tenantId);
    for (const p of riskyProjects) {
      if (await this.repo.pendingExists(tenantId, 'deal_at_risk', null, p.project_id)) continue;
      const rec = await this.repo.create({
        tenantId,
        type: 'deal_at_risk',
        projectId: p.project_id,
        taskId: null,
        isFinancial: true,
        payload: { projectId: p.project_id, reason: 'маржа ниже порога' },
      });
      created.push(rec);
      this.realtime.emitInternal(tenantId, p.project_id, 'recommendation.raised', { id: rec.id, type: 'deal_at_risk' });
    }

    return created;
  }

  /** Черновик апдейта клиенту — проходит маскирование PII (как любой текст в LLM). */
  async draftClientUpdate(tenantId: string, projectId: string, rawContext: string): Promise<RecommendationRow> {
    const { masked } = maskPII(rawContext);
    const draft = `Здравствуйте! Краткий апдейт по проекту: ${masked} Сроки под контролем, спасибо за доверие.`;
    return this.repo.create({
      tenantId,
      type: 'draft_client_update',
      projectId,
      taskId: null,
      isFinancial: false,
      payload: { draft, maskedContext: masked },
    });
  }

  list(tenantId: string, role: string) {
    const includeFinancial = role === 'owner' || role === 'manager';
    return this.repo.listActive(tenantId, includeFinancial);
  }

  async accept(tenantId: string, id: string, actorId: string) {
    const rec = await this.repo.get(tenantId, id);
    if (!rec || rec.status !== 'pending') throw AppException.notFound('Recommendation not found or resolved');

    if (rec.type === 'reassign' && rec.payload?.toAssigneeId && rec.payload?.taskId) {
      // выполнение через guarded-путь (то же, что ручное назначение), форсируем перегруз осознанно
      await this.forecast.assign(tenantId, rec.payload.taskId, rec.payload.toAssigneeId, actorId, true);
    }
    await this.repo.setStatus(tenantId, id, 'accepted');
    return { id, status: 'accepted' };
  }

  async dismiss(tenantId: string, id: string) {
    const rec = await this.repo.get(tenantId, id);
    if (!rec || rec.status !== 'pending') throw AppException.notFound('Recommendation not found or resolved');
    await this.repo.setStatus(tenantId, id, 'dismissed');
    return { id, status: 'dismissed' };
  }

  private async leastLoaded(tenantId: string, userIds: string[], exclude: string): Promise<string | null> {
    let best: string | null = null;
    let bestHours = Number.POSITIVE_INFINITY;
    for (const uid of userIds) {
      if (uid === exclude) continue;
      const h = await this.velocity.openQueueHours(tenantId, uid);
      if (h < bestHours) {
        bestHours = h;
        best = uid;
      }
    }
    return best;
  }
}
