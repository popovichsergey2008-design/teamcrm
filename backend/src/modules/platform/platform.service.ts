import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';

/** Сотрудник техотдела: где живёт его учётка, что ему можно и дежурит ли он сейчас. */
export interface StaffRow {
  user_id: string;
  tenant_id: string;
  full_name: string;
  role: string;
  active: boolean;
  skills: string[];
}

/** Пауза перед разметкой платформы: база к этому моменту уже накатила миграции. */
const SEED_DELAY_MS = 10_000;
/** Как долго держим в памяти номер организации-вендора: он не меняется. */
const CACHE_MS = 60_000;

/**
 * Платформа — организация разработчика продукта, и её техотдел.
 *
 * TeamCRM продаётся наружу, поэтому у службы заботы две стороны: клиентская
 * организация пишет, а отвечает вендор. Всё, что раньше было «настройками поддержки
 * компании», теперь принадлежит платформе и клиенту не видно вовсе.
 *
 * Кто платформа, система узнаёт из переменной окружения `PLATFORM_TENANT_ID` (или
 * `PLATFORM_ADMIN_EMAIL`) один раз при старте и запоминает флагом в базе. Догадываться
 * по «самой первой организации» нельзя: в базе разработки и в тестах первой окажется
 * случайная, и служба заботы всей системы уедет к чужому человеку.
 *
 * Если платформа не назначена, всё работает по-старому: обращения принимает владелец
 * организации обратившегося. Это важно — выкладка не должна оставить людей без
 * поддержки только потому, что переменную забыли прописать.
 */
@Injectable()
export class PlatformService implements OnModuleInit {
  private readonly log = new Logger('Platform');
  private cache: { id: string | null; at: number } = { id: null, at: 0 };

  constructor(private readonly db: DbService) {}

  onModuleInit(): void {
    const timer = setTimeout(() => void this.seed(), SEED_DELAY_MS);
    timer.unref?.(); // не держим процесс в тестах и консольных запусках
  }

  // ── кто платформа ──
  /** Номер организации-вендора или null, если платформа не назначена. */
  async tenantId(): Promise<string | null> {
    if (Date.now() - this.cache.at < CACHE_MS) return this.cache.id;
    const row = await this.db.one<{ id: string }>(
      `SELECT id::text FROM tenants WHERE is_platform LIMIT 1`,
    );
    this.cache = { id: row ? String(row.id) : null, at: Date.now() };
    return this.cache.id;
  }

  /**
   * Назначить организацию платформой и дать её человеку права техотдела.
   *
   * Отдельный публичный метод, а не только внутренность старта: им пользуются тесты,
   * и им же можно перенести платформу, если вендор переехал в другую организацию.
   */
  async declarePlatform(tenantId: string, adminUserId: string): Promise<void> {
    await this.db.query(`UPDATE tenants SET is_platform = FALSE WHERE is_platform`);
    await this.db.query(`UPDATE tenants SET is_platform = TRUE WHERE id=$1`, [tenantId]);
    await this.db.query(
      `INSERT INTO platform_staff (user_id, tenant_id, role, active)
       VALUES ($1,$2,'admin',TRUE)
       ON CONFLICT (user_id) DO UPDATE SET tenant_id=EXCLUDED.tenant_id, role='admin', active=TRUE`,
      [adminUserId, tenantId],
    );
    this.cache = { id: String(tenantId), at: Date.now() };
  }

  /**
   * Снять пометку платформы и распустить техотдел.
   *
   * Нужно при переносе вендора в другую организацию — и тестам, которые проверяют оба
   * порядка работы: с платформой и без неё.
   */
  async clearPlatform(): Promise<void> {
    const id = await this.tenantId();
    if (id) await this.db.query(`DELETE FROM platform_staff WHERE tenant_id=$1`, [id]);
    await this.db.query(`UPDATE tenants SET is_platform = FALSE WHERE is_platform`);
    this.cache = { id: null, at: Date.now() };
  }

  /** Разовая разметка платформы при старте — по переменной окружения. */
  private async seed(): Promise<void> {
    try {
      if (await this.tenantId()) return;
      const byId = process.env.PLATFORM_TENANT_ID?.trim();
      const byEmail = process.env.PLATFORM_ADMIN_EMAIL?.trim();
      if (!byId && !byEmail) return;

      const owner = byEmail
        ? await this.db.one<{ id: string; tenant_id: string }>(
          `SELECT id::text, tenant_id::text FROM users WHERE lower(email)=lower($1) AND is_active LIMIT 1`,
          [byEmail],
        )
        : await this.db.one<{ id: string; tenant_id: string }>(
          `SELECT u.id::text, u.tenant_id::text FROM users u JOIN roles r ON r.id = u.role_id
            WHERE u.tenant_id=$1 AND r.code='owner' AND u.is_active ORDER BY u.id LIMIT 1`,
          [byId],
        );
      if (!owner) {
        this.log.warn('организация-платформа не найдена: проверьте PLATFORM_TENANT_ID / PLATFORM_ADMIN_EMAIL');
        return;
      }
      await this.declarePlatform(String(owner.tenant_id), String(owner.id));
      this.log.log(`платформа: организация ${owner.tenant_id}, техотдел начат с ${owner.id}`);
    } catch (e) {
      this.log.warn(`разметка платформы не удалась: ${(e as Error).message}`);
    }
  }

  // ── техотдел ──
  /** Весь техотдел, включая снятых с дежурства: список для консоли. */
  staffAll(): Promise<StaffRow[]> {
    return this.db.many<StaffRow>(
      `SELECT s.user_id::text, s.tenant_id::text, u.full_name, s.role, s.active, s.skills
         FROM platform_staff s JOIN users u ON u.id = s.user_id
        WHERE u.is_active
        ORDER BY s.active DESC, u.full_name`,
    );
  }

  /** Кто дежурит: им идут обращения и им светится очередь. */
  async onDuty(): Promise<StaffRow[]> {
    return (await this.staffAll()).filter((s) => s.active);
  }

  async isStaff(userId: string): Promise<boolean> {
    const row = await this.db.one<{ user_id: string }>(
      `SELECT user_id::text FROM platform_staff WHERE user_id=$1`, [userId],
    );
    return !!row;
  }

  async isAdmin(userId: string): Promise<boolean> {
    const row = await this.db.one<{ role: string }>(
      `SELECT role FROM platform_staff WHERE user_id=$1`, [userId],
    );
    return row?.role === 'admin';
  }

  /** Права техотдела: без них консоли не существует. */
  async assertStaff(userId: string): Promise<void> {
    if (!(await this.isStaff(userId))) throw AppException.forbidden('Это консоль техподдержки продукта');
  }

  async assertAdmin(userId: string): Promise<void> {
    if (!(await this.isAdmin(userId))) throw AppException.forbidden('Состав техотдела меняет его администратор');
  }

  /**
   * Взять в техотдел или снять с дежурства.
   *
   * Берём только людей САМОЙ платформы: право читать обращения всех клиентов нельзя
   * выдать сотруднику клиентской организации ни по ошибке, ни намеренно.
   */
  async setStaff(
    actor: { userId: string }, userId: string,
    patch: { active?: boolean; role?: string; skills?: string[]; remove?: boolean },
  ): Promise<StaffRow[]> {
    await this.assertAdmin(actor.userId);
    const platform = await this.tenantId();
    if (!platform) throw AppException.conflict('Организация-платформа не назначена');

    if (patch.remove) {
      // Себя из техотдела не убираем: иначе консоль остаётся без администратора.
      if (String(userId) === String(actor.userId)) {
        throw AppException.validation('Нельзя убрать из техотдела самого себя');
      }
      await this.db.query(`DELETE FROM platform_staff WHERE user_id=$1`, [userId]);
      return this.staffAll();
    }

    const person = await this.db.one<{ id: string }>(
      `SELECT id::text FROM users WHERE id=$1 AND tenant_id=$2 AND is_active`, [userId, platform],
    );
    if (!person) throw AppException.validation('В техотдел берём только сотрудников платформы');

    /*
      Незаданное поле НЕ ТРОГАЕМ — ни при создании, ни при правке.

      Приведения типов у параметров обязательны: без них Postgres не выводит тип
      NULL-а в COALESCE и роняет весь запрос, а не только эту строку.
    */
    await this.db.query(
      `INSERT INTO platform_staff (user_id, tenant_id, role, active, skills, created_by)
       VALUES ($1, $2, COALESCE($3::varchar, 'agent'), COALESCE($4::boolean, TRUE),
               COALESCE($5::text[], '{}'), $6)
       ON CONFLICT (user_id) DO UPDATE
          SET role   = COALESCE($3::varchar, platform_staff.role),
              active = COALESCE($4::boolean, platform_staff.active),
              skills = COALESCE($5::text[], platform_staff.skills)`,
      [
        userId, platform,
        patch.role === 'admin' || patch.role === 'agent' ? patch.role : null,
        patch.active ?? null,
        patch.skills ? patch.skills.slice(0, 12) : null,
        actor.userId,
      ],
    );
    return this.staffAll();
  }

  /** Из кого выбирать: сотрудники платформы с отметкой «уже в техотделе». */
  async candidates() {
    const platform = await this.tenantId();
    if (!platform) return [];
    return this.db.many<{ id: string; full_name: string; position: string | null; in_staff: boolean; role: string | null; active: boolean | null }>(
      `SELECT u.id::text, u.full_name, p.name AS position,
              (s.user_id IS NOT NULL) AS in_staff, s.role, s.active
         FROM users u
         JOIN roles r ON r.id = u.role_id
         LEFT JOIN positions p ON p.id = u.position_id
         LEFT JOIN platform_staff s ON s.user_id = u.id
        WHERE u.tenant_id=$1 AND u.is_active AND r.code <> 'client'
        ORDER BY (s.user_id IS NOT NULL) DESC, u.full_name`,
      [platform],
    );
  }

  /**
   * Клиенты продукта — то, ради чего техотделу нужен свой кабинет.
   *
   * Только счётчики и последняя активность: содержимое чужих досок и переписок в
   * консоли не показывается никогда, сколько бы это ни было удобно поддержке.
   */
  async tenants(limit = 200) {
    const platform = await this.tenantId();
    return this.db.many<{
      id: string; name: string; people: string; open_convs: string;
      last_seen: Date | null; created_at: Date; is_platform: boolean;
    }>(
      `SELECT t.id::text, t.name, t.is_platform,
              (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id AND u.is_active) AS people,
              (SELECT COUNT(*) FROM support_conversations c
                WHERE c.tenant_id = t.id AND c.closed_at IS NULL) AS open_convs,
              (SELECT MAX(u.last_seen_at) FROM users u WHERE u.tenant_id = t.id) AS last_seen,
              t.created_at
         FROM tenants t
        WHERE $1::bigint IS NULL OR t.id <> $1::bigint
        ORDER BY last_seen DESC NULLS LAST, t.id
        LIMIT $2`,
      [platform, limit],
    );
  }
}
