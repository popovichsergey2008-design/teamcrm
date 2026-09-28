import { Injectable } from '@nestjs/common';
import { PlatformService } from '../platform/platform.service';
import { AnalyticsRepository, MilestoneRow } from './analytics.repository';
import {
  durationsOf, FunnelSummary, stepsOf, summarize, TenantDurations, TenantMilestones,
} from './onboarding-funnel';

/** Одна строка списка организаций: докуда дошла и за сколько. */
export interface TenantFunnelRow {
  tenantId: string;
  name: string;
  createdAt: string;
  /** Шаги как есть: null — не случилось. */
  steps: Record<string, string | null>;
  durations: TenantDurations;
  completed: boolean;
}

export interface FunnelReport {
  summary: FunnelSummary;
  tenants: TenantFunnelRow[];
}

const date = (v: string | null): Date | null => (v ? new Date(v) : null);

/**
 * Воронка онбординга для консоли техотдела (ТЗ-11, разд. 56-57).
 *
 * Это метрика ПРОДУКТА, а не организации: она отвечает нам на вопрос, где новые клиенты
 * застревают. Поэтому живёт в консоли вендора и клиенту не видна — ему незачем знать, как
 * проходят онбординг другие компании.
 */
@Injectable()
export class AnalyticsService {
  constructor(
    private readonly repo: AnalyticsRepository,
    private readonly platform: PlatformService,
  ) {}

  private static toMilestones(r: MilestoneRow): TenantMilestones {
    return {
      tenantId: r.tenant_id,
      name: r.name,
      createdAt: new Date(r.created_at),
      companyAt: date(r.company_at),
      telegramAt: date(r.telegram_at),
      departmentAt: date(r.department_at),
      inviteAt: date(r.invite_at),
      memberAt: date(r.member_at),
      projectAt: date(r.project_at),
      taskAt: date(r.task_at),
      completedAt: date(r.completed_at),
      invitesSent: Number(r.invites_sent),
      invitesAccepted: Number(r.invites_accepted),
      voiceJobs: Number(r.voice_jobs),
    };
  }

  async report(): Promise<FunnelReport> {
    const vendor = await this.platform.tenantId();
    const rows = (await this.repo.milestones(vendor ? String(vendor) : null))
      .map(AnalyticsService.toMilestones);

    return {
      summary: summarize(rows),
      tenants: rows.map((m) => {
        const steps = stepsOf(m);
        return {
          tenantId: m.tenantId,
          name: m.name,
          createdAt: m.createdAt.toISOString(),
          steps: Object.fromEntries(
            Object.entries(steps).map(([k, v]) => [k, v ? v.toISOString() : null]),
          ),
          durations: durationsOf(m),
          completed: !!m.completedAt,
        };
      }),
    };
  }
}
