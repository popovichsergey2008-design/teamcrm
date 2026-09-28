import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';

export interface MilestoneRow {
  tenant_id: string;
  name: string;
  created_at: string;
  company_at: string | null;
  telegram_at: string | null;
  department_at: string | null;
  invite_at: string | null;
  member_at: string | null;
  project_at: string | null;
  task_at: string | null;
  completed_at: string | null;
  invites_sent: number;
  invites_accepted: number;
  voice_jobs: number;
}

@Injectable()
export class AnalyticsRepository {
  constructor(private readonly db: DbService) {}

  /**
   * Первые события каждой организации — одним запросом.
   *
   * Группированные подзапросы, а не коррелированные: организаций десятки, а строк в
   * задачах миллионы, и `MIN(created_at) GROUP BY tenant_id` идёт по индексу один раз, а
   * не по разу на организацию.
   *
   * Организацию-вендора исключаем: свой собственный онбординг в продуктовой воронке
   * ничего не измеряет, зато портит все доли.
   */
  milestones(excludeTenantId: string | null): Promise<MilestoneRow[]> {
    return this.db.many<MilestoneRow>(
      `SELECT t.id::text AS tenant_id,
              t.name,
              t.created_at,
              o.company_confirmed_at AS company_at,
              o.completed_at,
              tg.first_at  AS telegram_at,
              dp.first_at  AS department_at,
              -- Приглашение могло быть и письмом, и общей ссылкой: берём то, что раньше.
              LEAST(iv.first_at, il.first_at) AS invite_at,
              mm.first_at  AS member_at,
              pr.first_at  AS project_at,
              tk.first_at  AS task_at,
              COALESCE(iv.sent, 0)     AS invites_sent,
              COALESCE(iv.accepted, 0) AS invites_accepted,
              COALESCE(vj.n, 0)        AS voice_jobs
         FROM tenants t
         LEFT JOIN tenant_onboarding o ON o.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, MIN(linked_at) AS first_at
                      FROM telegram_accounts GROUP BY tenant_id) tg ON tg.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, MIN(created_at) AS first_at
                      FROM groups WHERE kind = 'department' GROUP BY tenant_id) dp ON dp.tenant_id = t.id
         -- Принятые считаем только по письмам: у общей ссылки нет адресата, и сказать,
         -- «сколько её приняли из скольких», нельзя — считать её отказом было бы врать.
         LEFT JOIN (SELECT tenant_id, MIN(created_at) AS first_at,
                           COUNT(*)::int AS sent,
                           COUNT(accepted_at)::int AS accepted
                      FROM invites GROUP BY tenant_id) iv ON iv.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, MIN(created_at) AS first_at
                      FROM invite_links GROUP BY tenant_id) il ON il.tenant_id = t.id
         -- Второй человек в пространстве: владелец не считается, заказчик-клиент тоже.
         LEFT JOIN (SELECT u.tenant_id, MIN(u.created_at) AS first_at
                      FROM users u JOIN roles r ON r.id = u.role_id
                     WHERE r.code NOT IN ('owner', 'client') GROUP BY u.tenant_id) mm ON mm.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, MIN(created_at) AS first_at
                      FROM projects GROUP BY tenant_id) pr ON pr.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, MIN(created_at) AS first_at
                      FROM tasks WHERE deleted_at IS NULL GROUP BY tenant_id) tk ON tk.tenant_id = t.id
         LEFT JOIN (SELECT tenant_id, COUNT(*)::int AS n
                      FROM voice_jobs GROUP BY tenant_id) vj ON vj.tenant_id = t.id
        WHERE $1::bigint IS NULL OR t.id <> $1::bigint
        ORDER BY t.created_at DESC`,
      [excludeTenantId],
    );
  }
}
