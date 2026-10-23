import { Injectable, Logger } from '@nestjs/common';
import { DbService } from '../../database/db.service';
import { AppException } from '../../common/http/app-exception';
import { assigneeOwesSql } from '../tasks/responsibility';
import { ProactiveService } from '../proactive/proactive.service';
import { fingerprint } from '../proactive/proactive-rules';
import { isSkill, Skill, SKILL_LABEL } from '../team/skills';
import { directionsFromText } from '../team/direction-rules';
import {
  Choice, chooseAssignee, DEFAULT_POSITIONS, departmentsFor, isLevel, leadOf, LEVEL_LABEL, LEVELS, managerOf, mentionsRole,
  Org, RoleHit, roleAddressee,
} from './org-rules';

/** Сколько раз постановщик должен переназначить задачи направления на одного человека. */
export const LEARN_AFTER = 2;

export interface ChooseForInput {
  authorId: string | null;
  /** Название, описание и всё сказанное — по нему роли и направление. */
  text: string;
  projectId: string | null;
  /** Направления, если уже известны (руками, моделью); иначе — по словам текста. */
  directions?: string[] | null;
  /** Человек назван по имени. */
  namedUserId?: string | null;
  /** Кого выбрала модель по оргструктуре — берём, только если в тексте звучит роль. */
  modelAssigneeId?: string | null;
  anyWhenNoSkill?: boolean;
}

export interface ChooseForResult extends Choice { skill: Skill | null; directions: Skill[] }

/**
 * Структура компании (#4615, доработка 23.10): снимок для правила подбора и для
 * модели, «Кто отвечает за направление», обучение на правках постановщика.
 *
 * Глобальный модуль без встречных зависимостей: подбор нужен быстрой команде, форме,
 * чату, встречам и боту, а обучение — задачам.
 */
@Injectable()
export class OrgService {
  private readonly log = new Logger('Org');

  constructor(private readonly db: DbService, private readonly proactive: ProactiveService) {}

  /** Готовые должности новой компании — только если своих ещё нет. */
  async seedDefaults(tenantId: string): Promise<void> {
    await this.db.query(
      `INSERT INTO positions (tenant_id, name, level, sort_order)
       SELECT $1::bigint, d.name, d.level, d.ord
         FROM jsonb_to_recordset($2::jsonb) AS d(name text, level text, ord int)
        WHERE NOT EXISTS (SELECT 1 FROM positions p WHERE p.tenant_id = $1::bigint)
       ON CONFLICT (tenant_id, name) DO NOTHING`,
      [tenantId, JSON.stringify(DEFAULT_POSITIONS.map((p, i) => ({ ...p, ord: i + 1 })))],
    ).catch((e) => this.log.warn(`должности по умолчанию: ${(e as Error).message}`));
  }

  /** Снимок структуры: люди (кроме клиентов) и отделы. */
  async snapshot(tenantId: string): Promise<Org> {
    const [people, deps] = await Promise.all([
      this.db.many<{
        id: string; name: string; position_name: string | null; level: string | null; reports_to: string | null;
        skills: string[] | null; open_tasks: string; weight: string; can_receive: boolean;
      }>(
        `SELECT u.id::text, u.full_name AS name, p.name AS position_name, p.level, u.reports_to_user_id::text AS reports_to,
                COALESCE((SELECT array_agg(s.skill ORDER BY s.skill) FROM user_skills s WHERE s.user_id = u.id), '{}') AS skills,
                (SELECT count(*) FROM tasks t WHERE t.assignee_id = u.id AND t.tenant_id = u.tenant_id
                   AND t.closed_at IS NULL AND t.deleted_at IS NULL AND ${assigneeOwesSql('t')})::text AS open_tasks,
                u.auto_assignment_weight::text AS weight, u.can_receive_auto_tasks AS can_receive
           FROM users u JOIN roles r ON r.id = u.role_id
           LEFT JOIN positions p ON p.id = u.position_id
          WHERE u.tenant_id = $1 AND u.is_active = TRUE AND r.code <> 'client'
          ORDER BY u.full_name`, [tenantId],
      ),
      this.db.many<{
        id: string; name: string; lead_user_id: string | null; directions: string[] | null; parent_id: string | null;
        member_ids: string[] | null; deputy_ids: string[] | null;
      }>(
        `SELECT g.id::text, g.name, g.lead_user_id::text, g.directions, g.parent_id::text,
                COALESCE(array_agg(ug.user_id::text) FILTER (WHERE ug.user_id IS NOT NULL), '{}') AS member_ids,
                COALESCE(array_agg(ug.user_id::text) FILTER (WHERE ug.role = 'deputy'), '{}') AS deputy_ids
           FROM groups g LEFT JOIN user_groups ug ON ug.group_id = g.id
          WHERE g.tenant_id = $1 AND g.kind = 'department'
          GROUP BY g.id ORDER BY g.name`, [tenantId],
      ),
    ]);
    const active = new Set(people.map((p) => String(p.id)));
    return {
      people: people.map((p) => ({
        id: String(p.id), name: p.name, positionName: p.position_name, level: isLevel(p.level) ? p.level : null,
        reportsTo: p.reports_to && active.has(String(p.reports_to)) ? String(p.reports_to) : null,
        skills: p.skills ?? [], openTasks: Number(p.open_tasks ?? 0), weight: Number(p.weight ?? 1) || 1,
        canReceive: p.can_receive !== false,
      })),
      departments: deps.map((d) => ({
        id: String(d.id), name: d.name,
        leadUserId: d.lead_user_id && active.has(String(d.lead_user_id)) ? String(d.lead_user_id) : null,
        deputyIds: (d.deputy_ids ?? []).map(String).filter((u) => active.has(u)),
        memberIds: (d.member_ids ?? []).map(String).filter((u) => active.has(u)),
        directions: (d.directions ?? []).filter(isSkill), parentId: d.parent_id ? String(d.parent_id) : null,
      })),
    };
  }

  /**
   * Кто видит проекты — те же правила, что у доступа к проекту: владелец и менеджеры
   * компании, проект «для всех», хозяин проекта, участники. Клиентов не берём.
   */
  async seers(tenantId: string, projectIds: string[]): Promise<Map<string, Set<string>>> {
    const out = new Map<string, Set<string>>();
    const ids = [...new Set(projectIds.filter(Boolean).map(String))];
    if (!ids.length) return out;
    const rows = await this.db.many<{ project_id: string; user_id: string }>(
      `SELECT p.id::text AS project_id, u.id::text AS user_id
         FROM projects p
         JOIN users u ON u.tenant_id = p.tenant_id AND u.is_active = TRUE
         JOIN roles r ON r.id = u.role_id
        WHERE p.tenant_id=$1 AND p.id = ANY($2::bigint[]) AND r.code <> 'client'
          AND (r.code IN ('owner', 'manager') OR p.visibility = 'all' OR p.owner_user_id = u.id
               OR EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = u.id))`,
      [tenantId, ids],
    ).catch(() => []);
    for (const id of ids) out.set(id, new Set());
    for (const r of rows) out.get(String(r.project_id))!.add(String(r.user_id));
    return out;
  }

  /**
   * Роль в тексте + направление → исполнитель по одному правилу. Чистое ядро —
   * `chooseAssignee`; здесь только то, что одинаково для всех путей.
   */
  decide(org: Org, canSee: (u: string) => boolean, input: Omit<ChooseForInput, 'projectId'>): ChooseForResult {
    const hit = roleAddressee(input.text, org, input.authorId);
    let role: RoleHit | null = hit && 'userIds' in hit ? hit : null;
    // роль сказана, правила человека не нашли, а модель по оргструктуре нашла — берём её выбор
    if (!role && !input.namedUserId && input.modelAssigneeId && mentionsRole(input.text)
      && org.people.some((p) => p.id === String(input.modelAssigneeId))) {
      role = { userIds: [String(input.modelAssigneeId)], skill: null, reason: 'по структуре компании' };
    }
    const given = (input.directions ?? []).filter(isSkill);
    const directions = given.length ? given : directionsFromText(input.text);
    const roleSkill = hit && !('userIds' in hit) ? hit.skill : role?.skill ?? null;
    const skill = roleSkill ?? directions[0] ?? null;
    const choice = chooseAssignee(org, {
      authorId: input.authorId, namedUserId: input.namedUserId ?? null, role, skill, canSee,
      anyWhenNoSkill: input.anyWhenNoSkill,
    });
    return { ...choice, skill, directions: [...new Set([...(roleSkill ? [roleSkill] : []), ...directions])].filter((d) => d !== 'fullstack' && d !== 'other') as Skill[] };
  }

  /** Одна задача: снимок, кто видит проект, правило. */
  async chooseFor(tenantId: string, input: ChooseForInput): Promise<ChooseForResult> {
    const [org, seers] = await Promise.all([
      this.snapshot(tenantId),
      input.projectId ? this.seers(tenantId, [String(input.projectId)]) : Promise.resolve(new Map<string, Set<string>>()),
    ]);
    const see = input.projectId ? seers.get(String(input.projectId)) ?? new Set<string>() : null;
    return this.decide(org, (u) => !see || see.has(String(u)), input);
  }

  // ───────────────────────── экран структуры ─────────────────────────

  /** Для оргсхемы: люди с руководителем (заданным или по отделу), отделы, должности, уровни. */
  async structure(tenantId: string) {
    const [org, positions] = await Promise.all([
      this.snapshot(tenantId),
      this.db.many<{ id: string; name: string; level: string; sort_order: number }>(
        `SELECT id::text, name, level, sort_order FROM positions WHERE tenant_id=$1 ORDER BY sort_order, name`, [tenantId]),
    ]);
    return {
      levels: LEVELS.map((code) => ({ code, label: LEVEL_LABEL[code] })),
      positions,
      departments: org.departments.map((d) => ({ ...d, effectiveLeadId: leadOf(org, d) })),
      people: org.people.map((p) => ({
        id: p.id, name: p.name, positionName: p.positionName, level: p.level, skills: p.skills,
        reportsTo: p.reportsTo, managerId: managerOf(org, p.id),
      })),
      // фулстек — не отдельное направление отдела: его берут отделы бэкенда и фронтенда
      directions: (Object.keys(SKILL_LABEL) as Skill[]).filter((s) => s !== 'other' && s !== 'fullstack')
        .map((s) => ({ code: s, label: SKILL_LABEL[s], hasLead: departmentsFor(org, s).some((d) => !!leadOf(org, d)) })),
    };
  }

  /**
   * «Кто отвечает за <направление>?» — назначить руководителя направления.
   *
   * Отдел этого направления без руководителя (или только этого направления) — ставим
   * руководителем. У отдела другой руководитель и другие направления — направление
   * выделяется во вложенный отдел. Отдела нет — создаём отдел по названию направления.
   */
  async setDirectionLead(tenantId: string, skill: Skill, userId: string): Promise<{ departmentId: string; departmentName: string }> {
    if (!isSkill(skill) || skill === 'other') throw AppException.validation('Неизвестное направление');
    const user = await this.db.one<{ id: string; name: string }>(
      `SELECT u.id::text, u.full_name AS name FROM users u JOIN roles r ON r.id = u.role_id
        WHERE u.tenant_id=$1 AND u.id=$2 AND u.is_active AND r.code <> 'client'`, [tenantId, userId]);
    if (!user) throw AppException.validation('Сотрудник не найден');
    const org = await this.snapshot(tenantId);
    const label = SKILL_LABEL[skill];
    const exact = org.departments.filter((d) => d.directions.includes(skill));
    let target: { id: string; name: string } | null = null;

    const free = exact.find((d) => !d.leadUserId || d.leadUserId === user.id || d.directions.length === 1);
    if (free) {
      await this.db.query(`UPDATE groups SET lead_user_id=$3 WHERE tenant_id=$1 AND id=$2`, [tenantId, free.id, user.id]);
      target = free;
    } else if (exact.length) {
      // у отдела свой руководитель и несколько направлений — направление отдельным вложенным отделом
      const parent = exact[0];
      await this.db.query(`UPDATE groups SET directions = array_remove(directions, $3) WHERE tenant_id=$1 AND id=$2`, [tenantId, parent.id, skill]);
      target = await this.createDepartment(tenantId, label, skill, user.id, parent.id);
    } else {
      // отдел человека без руководителя и без направлений — дописываем направление туда
      const home = org.departments.find((d) => d.memberIds.includes(user.id) && !leadOf(org, d) && !d.directions.length);
      if (home) {
        await this.db.query(
          `UPDATE groups SET lead_user_id=$3, directions = array_append(directions, $4) WHERE tenant_id=$1 AND id=$2`,
          [tenantId, home.id, user.id, skill]);
        target = home;
      } else {
        target = await this.createDepartment(tenantId, label, skill, user.id, null);
      }
    }
    await this.db.query(
      `INSERT INTO user_groups (tenant_id, user_id, group_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, user.id, target.id]);
    return { departmentId: target.id, departmentName: target.name };
  }

  private async createDepartment(tenantId: string, label: string, skill: Skill, leadId: string, parentId: string | null) {
    // название занято (группой или отделом) — берём свободное
    for (const name of [label, `${label} (направление)`, `Направление «${label}»`]) {
      const row = await this.db.one<{ id: string; name: string }>(
        `INSERT INTO groups (tenant_id, name, kind, lead_user_id, directions, parent_id)
         VALUES ($1,$2,'department',$3,ARRAY[$4]::text[],$5) ON CONFLICT (tenant_id, name) DO NOTHING
         RETURNING id::text, name`, [tenantId, name, leadId, skill, parentId]);
      if (row) return row;
    }
    throw AppException.conflict('Не получилось завести отдел направления — переименуйте похожие группы');
  }

  // ───────────────────────── обучение на правках ─────────────────────────

  /**
   * Постановщик переназначил задачу направления на другого человека. Два раза на одного
   * и того же — карточка «Сделать <Имя> руководителем по <направлению>?» [Да] [Нет].
   * Спрашиваем только тех, кто вправе менять структуру (владелец, руководитель).
   */
  async noteReassign(tenantId: string, input: { taskId: string; actorId: string; assigneeId: string }): Promise<void> {
    try {
      const t = await this.db.one<{ created_by: string | null; directions: string[] | null; role: string | null }>(
        `SELECT t.created_by::text, t.directions,
                (SELECT r.code FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $3) AS role
           FROM tasks t WHERE t.tenant_id=$1 AND t.id=$2`, [tenantId, input.taskId, input.actorId]);
      if (!t || String(t.created_by ?? '') !== String(input.actorId) || String(input.assigneeId) === String(input.actorId)) return;
      if (!['owner', 'manager'].includes(String(t.role))) return;
      const skill = (t.directions ?? []).find(isSkill);
      if (!skill) return;
      await this.db.query(
        `INSERT INTO org_reassign_log (tenant_id, manager_id, skill, user_id, task_id) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (task_id, user_id) DO NOTHING`,
        [tenantId, input.actorId, skill, input.assigneeId, input.taskId]);
      const n = Number((await this.db.one<{ n: string }>(
        `SELECT count(DISTINCT task_id)::text AS n FROM org_reassign_log
          WHERE tenant_id=$1 AND manager_id=$2 AND skill=$3 AND user_id=$4`,
        [tenantId, input.actorId, skill, input.assigneeId]))?.n ?? 0);
      if (n < LEARN_AFTER) return;
      const org = await this.snapshot(tenantId);
      if (departmentsFor(org, skill).some((d) => leadOf(org, d) === String(input.assigneeId))) return; // уже руководит
      const person = org.people.find((p) => p.id === String(input.assigneeId));
      if (!person) return;
      const label = SKILL_LABEL[skill];
      await this.proactive.propose({
        tenantId, userId: String(input.actorId), skill: 'autotask', kind: 'lead',
        sourceType: 'user', sourceId: person.id, sourceAt: new Date(), sourceLabel: person.name, sourceLink: '/settings/team',
        title: `Сделать ${person.name} руководителем по направлению «${label}»?`,
        summary: `Вы уже ${n} раза переназначали задачи направления «${label}» на ${person.name}. Сделать руководителем — и такие задачи будут сразу уходить ему.`,
        why: 'Система учится на ваших правках: так задачи сразу попадут нужному человеку.',
        recommend: `назначить ${person.name} руководителем направления «${label}»`,
        effect: '«Да» запишет его руководителем направления в «Настройки → Команда»; «Нет» — ничего не поменяет.',
        priority: 2, confidence: 0.8,
        actions: [
          { key: 'lead_yes', label: 'Да', risk: 'low_write', primary: true },
          { key: 'lead_no', label: 'Нет' },
        ],
        payload: { skill, userId: person.id },
        fingerprint: fingerprint({ skill: 'autotask', sourceType: 'lead', sourceId: `${skill}:${person.id}` }),
        expiresAt: new Date(Date.now() + 14 * 86400_000),
      });
    } catch (e) {
      this.log.warn(`обучение на правке задачи ${input.taskId}: ${(e as Error).message}`);
    }
  }
}
