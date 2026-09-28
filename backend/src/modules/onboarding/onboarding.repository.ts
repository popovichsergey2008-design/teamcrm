import { Injectable } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { OnboardingFacts, StepKey } from './onboarding-steps';

export interface OnboardingRow {
  skipped: string[];
  dismissed: boolean;
  company_confirmed_at: string | null;
  completed_at: string | null;
}

export interface CompanyRow {
  name: string;
  timezone: string;
  industry: string | null;
  logo_file_id: string | null;
}

/**
 * Состояние пути владельца и то, из чего оно считается.
 *
 * Факты собираются ОДНИМ запросом: шесть отдельных счётчиков ради подсказки, которая
 * обновляется на каждом открытии экрана, — расточительство, а сама подсказка не стоит
 * того, чтобы её ждали.
 */
@Injectable()
export class OnboardingRepository {
  constructor(private readonly db: DbService) {}

  /** Строка состояния; её может не быть у организаций, созданных до появления пути. */
  state(tenantId: string): Promise<OnboardingRow | null> {
    return this.db.one<OnboardingRow>(
      `SELECT skipped, dismissed, company_confirmed_at, completed_at
         FROM tenant_onboarding WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  /** Завести строку состояния, если её ещё нет. */
  async ensure(tenantId: string, ownerUserId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tenant_onboarding (tenant_id, owner_user_id)
            VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, ownerUserId],
    );
  }

  /**
   * Чем живёт организация на самом деле.
   *
   * Клиентов в «команду» не считаем: приглашённый заказчик — это не коллега, и шаг
   * «пригласить команду» он не закрывает.
   */
  async facts(tenantId: string, ownerUserId: string): Promise<Omit<OnboardingFacts, 'companyConfirmed'>> {
    const row = await this.db.one<{
      departments: number; teammates: number; invites: number; projects: number; tasks: number;
    }>(
      `SELECT
         (SELECT COUNT(*)::int FROM groups g
           WHERE g.tenant_id = $1 AND g.kind = 'department') AS departments,
         (SELECT COUNT(*)::int FROM users u
            JOIN roles r ON r.id = u.role_id
           WHERE u.tenant_id = $1 AND u.is_active AND u.id <> $2 AND r.code <> 'client') AS teammates,
         (SELECT COUNT(*)::int FROM invites i WHERE i.tenant_id = $1)
         + (SELECT COUNT(*)::int FROM invite_links l WHERE l.tenant_id = $1) AS invites,
         (SELECT COUNT(*)::int FROM projects p
           WHERE p.tenant_id = $1 AND p.status <> 'archived') AS projects,
         (SELECT COUNT(*)::int FROM tasks t
           WHERE t.tenant_id = $1 AND t.deleted_at IS NULL) AS tasks`,
      [tenantId, ownerUserId],
    );
    return {
      departments: row?.departments ?? 0,
      teammates: row?.teammates ?? 0,
      invites: row?.invites ?? 0,
      projects: row?.projects ?? 0,
      tasks: row?.tasks ?? 0,
    };
  }

  company(tenantId: string): Promise<CompanyRow | null> {
    return this.db.one<CompanyRow>(
      `SELECT name, timezone, industry, logo_file_id::text FROM tenants WHERE id = $1`,
      [tenantId],
    );
  }

  /** Настройки компании. Пустые поля не трогаем: «не прислали» — не «очистить». */
  async saveCompany(
    tenantId: string,
    patch: { name?: string; timezone?: string; industry?: string | null; logoFileId?: string | null },
  ): Promise<void> {
    await this.db.query(
      `UPDATE tenants
          SET name         = COALESCE($2, name),
              timezone     = COALESCE($3, timezone),
              industry     = COALESCE($4, industry),
              logo_file_id = COALESCE($5::bigint, logo_file_id),
              updated_at   = now()
        WHERE id = $1`,
      [tenantId, patch.name ?? null, patch.timezone ?? null, patch.industry ?? null, patch.logoFileId ?? null],
    );
  }

  /** Логотип: ставим ссылку на уже загруженный файл. */
  async setLogo(tenantId: string, fileId: string | null): Promise<void> {
    await this.db.query(
      `UPDATE tenants SET logo_file_id = $2::bigint, updated_at = now() WHERE id = $1`,
      [tenantId, fileId],
    );
  }

  async confirmCompany(tenantId: string): Promise<void> {
    await this.db.query(
      `UPDATE tenant_onboarding
          SET company_confirmed_at = COALESCE(company_confirmed_at, now()), updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  /** Отложить шаг. Повторное «Позже» ничего не портит: список без повторов. */
  async skip(tenantId: string, step: StepKey): Promise<void> {
    await this.db.query(
      `UPDATE tenant_onboarding
          SET skipped = (SELECT ARRAY(SELECT DISTINCT unnest(skipped || ARRAY[$2::text]))),
              updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId, step],
    );
  }

  async setDismissed(tenantId: string, dismissed: boolean): Promise<void> {
    await this.db.query(
      `UPDATE tenant_onboarding SET dismissed = $2, updated_at = now() WHERE tenant_id = $1`,
      [tenantId, dismissed],
    );
  }

  /** Отметить путь пройденным — один раз: повторное завершение ничего не меняет. */
  async markCompleted(tenantId: string): Promise<void> {
    await this.db.query(
      `UPDATE tenant_onboarding
          SET completed_at = COALESCE(completed_at, now()), updated_at = now()
        WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  /** Существующие отделы по именам: чтобы не заводить второй «Продажи». */
  async departmentNames(tenantId: string): Promise<string[]> {
    const rows = await this.db.many<{ name: string }>(
      `SELECT name FROM groups WHERE tenant_id = $1 AND kind = 'department'`,
      [tenantId],
    );
    return rows.map((r) => r.name);
  }

  /**
   * Завести отделы списком.
   *
   * `ON CONFLICT DO NOTHING` по уникальному имени: человек мог нажать «Создать» дважды
   * или добавить отдел, который уже есть. Ошибка здесь была бы бессмысленной — он
   * хотел, чтобы отдел существовал, и он существует.
   */
  async addDepartments(tenantId: string, names: string[]): Promise<number> {
    if (!names.length) return 0;
    const res = await this.db.query(
      `INSERT INTO groups (tenant_id, name, kind)
            SELECT $1, x.name, 'department' FROM unnest($2::text[]) AS x(name)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, names],
    );
    return res.rowCount ?? 0;
  }
}
