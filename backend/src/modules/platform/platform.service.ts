import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';

/**
 * Роли техотдела (03_SUPPORT_RBAC_AND_SECURITY).
 *
 * Плоского «сотрудника техотдела» недостаточно для коммерческой поддержки: дежурный
 * первой линии и инженер занимаются разным и должны видеть разное. Инженер, которого
 * позвали починить одну поломку, не должен получать очередь всех клиентов.
 */
export type PlatformRole = 'support' | 'support_admin' | 'engineer' | 'incident_manager' | 'admin';

export const PLATFORM_ROLES: PlatformRole[] = [
  'support', 'support_admin', 'engineer', 'incident_manager', 'admin',
];

/** Кто работает с очередью и обращениями. Инженера здесь нет намеренно. */
export const DESK_ROLES: PlatformRole[] = ['support', 'support_admin', 'incident_manager', 'admin'];
/** Кто настраивает службу: состав отдела, известные проблемы, справочник. */
export const MANAGE_ROLES: PlatformRole[] = ['support_admin', 'admin'];
/** Кто объявляет и закрывает массовый сбой. */
export const INCIDENT_ROLES: PlatformRole[] = ['support_admin', 'incident_manager', 'admin'];

/** Человеческие названия — для консоли. */
export const ROLE_TITLES: Record<PlatformRole, string> = {
  support: 'первая линия',
  support_admin: 'руководитель поддержки',
  engineer: 'инженер',
  incident_manager: 'дежурный по авариям',
  admin: 'администратор платформы',
};

/** Сотрудник техотдела: где живёт его учётка, что ему можно и дежурит ли он сейчас. */
export interface StaffRow {
  user_id: string;
  tenant_id: string;
  full_name: string;
  role: string;
  active: boolean;
  skills: string[];
  /** Сколько разговоров тянет одновременно: больше — новые не назначаются. */
  max_conversations: number;
}

/** Пауза перед разметкой платформы: база к этому моменту уже накатила миграции. */
const SEED_DELAY_MS = 10_000;
/** Как долго держим в памяти номер организации-вендора: он не меняется. */
const CACHE_MS = 60_000;

/**
 * Платформа — организация разработчика продукта, и её техотдел.
 *
 * ANTHILL продаётся наружу, поэтому у службы заботы две стороны: клиентская
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
      if (!byId && !byEmail) {
        if (!this.fallbackAllowed()) {
          this.log.error(
            'PLATFORM_TENANT_ID не задан, а запасной путь в бою выключен: '
            + 'обращения в службу заботы принимать НЕКОМУ. Укажите организацию-вендора.',
          );
        }
        return;
      }

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
      `SELECT s.user_id::text, s.tenant_id::text, u.full_name, s.role, s.active, s.skills,
              s.max_conversations
         FROM platform_staff s JOIN users u ON u.id = s.user_id
        WHERE u.is_active
        ORDER BY s.active DESC, u.full_name`,
    );
  }

  /** Кто дежурит: им идут обращения и им светится очередь. */
  async onDuty(): Promise<StaffRow[]> {
    return (await this.staffAll()).filter((s) => s.active);
  }

  /**
   * Роль человека в техотделе — или null, если он не наш.
   *
   * Сверяем и организацию: право читать чужие обращения не должно достаться человеку
   * клиентской компании ни по ошибке в данных, ни после переезда учётки. Раньше это
   * держалось на проверке в соседнем методе — теперь на самом правиле.
   */
  async roleOf(userId: string): Promise<PlatformRole | null> {
    const platform = await this.tenantId();
    if (!platform) return null;
    const row = await this.db.one<{ role: string }>(
      `SELECT s.role FROM platform_staff s JOIN users u ON u.id = s.user_id
        WHERE s.user_id=$1 AND s.tenant_id=$2 AND u.tenant_id=$2 AND u.is_active`,
      [userId, platform],
    );
    return row && (PLATFORM_ROLES as string[]).includes(row.role) ? (row.role as PlatformRole) : null;
  }

  async isStaff(userId: string): Promise<boolean> {
    return (await this.roleOf(userId)) !== null;
  }

  /** Работает с очередью и обращениями (инженер — нет). */
  async canDesk(userId: string): Promise<boolean> {
    const role = await this.roleOf(userId);
    return !!role && DESK_ROLES.includes(role);
  }

  /** Настраивает службу: состав отдела, известные проблемы, справочник. */
  async canManage(userId: string): Promise<boolean> {
    const role = await this.roleOf(userId);
    return !!role && MANAGE_ROLES.includes(role);
  }

  /** Объявляет и закрывает массовый сбой. */
  async canIncident(userId: string): Promise<boolean> {
    const role = await this.roleOf(userId);
    return !!role && INCIDENT_ROLES.includes(role);
  }

  async isEngineer(userId: string): Promise<boolean> {
    return (await this.roleOf(userId)) === 'engineer';
  }

  /**
   * Запасной путь «обращения принимает владелец организации».
   *
   * В коробочном продукте он недопустим (03_RBAC §18): владелец компании-клиента не
   * должен получать права нашей поддержки только потому, что переменную окружения
   * забыли прописать. В разработке и standalone-режиме — наоборот, единственный
   * способ работать без настройки платформы.
   */
  fallbackAllowed(): boolean {
    return process.env.NODE_ENV !== 'production';
  }

  async isAdmin(userId: string): Promise<boolean> {
    return (await this.roleOf(userId)) === 'admin';
  }

  /** Права техотдела: без них консоли не существует. */
  async assertStaff(userId: string): Promise<void> {
    if (!(await this.isStaff(userId))) throw AppException.forbidden('Это консоль техподдержки продукта');
  }

  /** Состав отдела и настройки службы — руководителю поддержки и администратору. */
  async assertAdmin(userId: string): Promise<void> {
    if (!(await this.canManage(userId))) {
      throw AppException.forbidden('Состав техотдела меняет руководитель поддержки');
    }
  }

  /**
   * Взять в техотдел или снять с дежурства.
   *
   * Берём только людей САМОЙ платформы: право читать обращения всех клиентов нельзя
   * выдать сотруднику клиентской организации ни по ошибке, ни намеренно.
   */
  async setStaff(
    actor: { userId: string }, userId: string,
    patch: { active?: boolean; role?: string; skills?: string[]; maxConversations?: number; remove?: boolean },
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
      `INSERT INTO platform_staff (user_id, tenant_id, role, active, skills, created_by, max_conversations)
       VALUES ($1, $2, COALESCE($3::varchar, 'support'), COALESCE($4::boolean, TRUE),
               COALESCE($5::text[], '{}'), $6, COALESCE($7::smallint, 5))
       ON CONFLICT (user_id) DO UPDATE
          SET role   = COALESCE($3::varchar, platform_staff.role),
              active = COALESCE($4::boolean, platform_staff.active),
              skills = COALESCE($5::text[], platform_staff.skills),
              max_conversations = COALESCE($7::smallint, platform_staff.max_conversations)`,
      [
        userId, platform,
        patch.role && (PLATFORM_ROLES as string[]).includes(patch.role) ? patch.role : null,
        patch.active ?? null,
        patch.skills ? patch.skills.slice(0, 12) : null,
        actor.userId,
        patch.maxConversations && patch.maxConversations > 0 ? Math.min(patch.maxConversations, 50) : null,
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
