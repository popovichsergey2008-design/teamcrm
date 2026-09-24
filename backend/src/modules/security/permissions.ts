/**
 * Права, области их действия и то, как они складываются (ТЗ «Централизованная
 * система безопасности»).
 *
 * Здесь нет ни базы, ни HTTP — только правила. Причина простая: это ровно тот код,
 * который ошибается молча и дорого. «Сотрудник вдруг может удалять чужие задачи» или
 * «администратор снял с себя ограничение» не проявляется ошибкой на экране — это
 * выясняется через месяц по последствиям. Поэтому правила собраны в одном месте и
 * проверяются тестами, а не глазами на живых данных.
 *
 * Главное правило слоя: решение принимает сервер. Интерфейс пользуется теми же
 * правилами, чтобы не показывать заведомо запрещённое, но его расчёт ничего не значит.
 */

/** Ключ права. Закрытый список: незнакомое право — ошибка, а не «разрешено». */
export const PERMISSIONS = [
  // организация и люди
  'organization.manage',
  'employee.view', 'employee.manage',
  'department.manage',
  // проекты и задачи
  'project.view', 'project.create', 'project.edit', 'project.delete', 'project.manage_members',
  'project.view_finance',
  'task.view', 'task.create', 'task.edit', 'task.assign', 'task.delete', 'task.restore',
  'task.delete_permanently', 'task.export',
  // клиенты и контакты
  'contact.view', 'contact.reveal', 'contact.copy', 'contact.export', 'contact.bulk_reveal',
  'crm.view', 'crm.edit',
  // переписка и файлы
  'chat.view', 'chat.write', 'file.download',
  // ИИ и автоматизации
  'ai.use', 'ai.manage',
  // интеграции, выгрузки, безопасность
  'integration.view', 'integration.manage',
  'export.create',
  'security.manage', 'audit.view',
] as const;

export type Permission = typeof PERMISSIONS[number];

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * Насколько широко действует право.
 *
 * `all` — везде в организации, `project` — в проектах, где человек участник,
 * `assigned` — только своя работа, `created_by_me` — то, что он сам завёл,
 * `none` — нигде (то же, что запрет, но говорит о причине яснее).
 */
export const SCOPES = ['all', 'department', 'project', 'assigned', 'created_by_me', 'none'] as const;
export type Scope = typeof SCOPES[number];

export function isScope(value: unknown): value is Scope {
  return typeof value === 'string' && (SCOPES as readonly string[]).includes(value);
}

export interface Grant {
  allowed: boolean;
  scope?: Scope;
}

export type PermissionMap = Partial<Record<Permission, Grant>>;

/** Базовые роли продукта: на них держится вход, удалить их нельзя. */
export type BaseRole = 'owner' | 'manager' | 'member' | 'client';

const ALL: Grant = { allowed: true, scope: 'all' };
const NO: Grant = { allowed: false };

/**
 * Права базовых ролей — то, как система работала до этого слоя.
 *
 * Менять умолчания задним числом нельзя: у работающих компаний это отняло бы
 * возможности без предупреждения. Поэтому набор описывает СЕГОДНЯШНЕЕ поведение, а
 * всё, что владелец захочет ужесточить, он ужесточает сам.
 *
 * Единственное исключение — удаление насовсем: раньше задача исчезала навсегда у
 * любого сотрудника, теперь у всех, кроме владельца, она уходит в корзину. Это не
 * отнятая возможность, а страховка: восстановить можно, а вернуть стёртое — нет.
 */
const BASE: Record<BaseRole, PermissionMap> = {
  owner: Object.fromEntries(PERMISSIONS.map((p) => [p, ALL])) as PermissionMap,
  manager: {
    'employee.view': ALL, 'employee.manage': ALL, 'department.manage': ALL,
    'project.view': ALL, 'project.create': ALL, 'project.edit': ALL, 'project.delete': ALL,
    'project.manage_members': ALL, 'project.view_finance': ALL,
    'task.view': ALL, 'task.create': ALL, 'task.edit': ALL, 'task.assign': ALL,
    'task.delete': ALL, 'task.restore': ALL, 'task.delete_permanently': NO, 'task.export': ALL,
    'contact.view': ALL, 'contact.reveal': ALL, 'contact.copy': ALL, 'contact.export': ALL, 'contact.bulk_reveal': NO,
    'crm.view': ALL, 'crm.edit': ALL,
    'chat.view': ALL, 'chat.write': ALL, 'file.download': ALL,
    'ai.use': ALL, 'ai.manage': ALL,
    'integration.view': ALL, 'integration.manage': NO,
    'export.create': ALL,
    'organization.manage': NO, 'security.manage': NO, 'audit.view': ALL,
  },
  member: {
    'employee.view': ALL, 'employee.manage': NO, 'department.manage': NO,
    'project.view': ALL, 'project.create': ALL, 'project.edit': ALL, 'project.delete': ALL,
    'project.manage_members': ALL, 'project.view_finance': NO,
    'task.view': ALL, 'task.create': ALL, 'task.edit': ALL, 'task.assign': ALL,
    'task.delete': ALL, 'task.restore': ALL, 'task.delete_permanently': NO, 'task.export': ALL,
    'contact.view': ALL, 'contact.reveal': ALL, 'contact.copy': ALL, 'contact.export': NO, 'contact.bulk_reveal': NO,
    'crm.view': ALL, 'crm.edit': ALL,
    'chat.view': ALL, 'chat.write': ALL, 'file.download': ALL,
    'ai.use': ALL, 'ai.manage': NO,
    'integration.view': ALL, 'integration.manage': NO,
    'export.create': ALL,
    'organization.manage': NO, 'security.manage': NO, 'audit.view': NO,
  },
  client: {
    'project.view': { allowed: true, scope: 'project' },
    'task.view': { allowed: true, scope: 'project' },
    'chat.view': { allowed: true, scope: 'project' },
    'chat.write': { allowed: true, scope: 'project' },
    'file.download': { allowed: true, scope: 'project' },
  },
};

export function baseRolePermissions(role: string): PermissionMap {
  return BASE[(role as BaseRole)] ?? {};
}

/**
 * Итоговые права человека.
 *
 * Складываются в три слоя, от общего к частному: базовая роль → своя роль компании →
 * личные поправки. Личная поправка сильнее всего: ради неё слой и затевался —
 * «этот администратор делает всё, кроме контактов».
 */
export function effectivePermissions(
  baseRole: string,
  customRole: PermissionMap | null | undefined,
  overrides: PermissionMap | null | undefined,
): PermissionMap {
  const out: PermissionMap = { ...baseRolePermissions(baseRole) };
  for (const [key, grant] of Object.entries(customRole ?? {})) {
    if (isPermission(key) && grant) out[key] = grant;
  }
  for (const [key, grant] of Object.entries(overrides ?? {})) {
    if (isPermission(key) && grant) out[key] = grant;
  }
  return out;
}

/** Разрешено ли действие. Незнакомое право — запрет: «не описано» не значит «можно». */
export function can(perms: PermissionMap, permission: Permission): boolean {
  const grant = perms[permission];
  return !!grant?.allowed && grant.scope !== 'none';
}

/** С какой широтой разрешено. Нет права — `none`. */
export function scopeOf(perms: PermissionMap, permission: Permission): Scope {
  const grant = perms[permission];
  if (!grant?.allowed) return 'none';
  return grant.scope ?? 'all';
}

/**
 * Проверка области для конкретной вещи.
 *
 * `all` — можно; `created_by_me` — только то, что человек завёл сам; `assigned` —
 * то, что на нём; `project` — то, где он участник. Решение принимает вызывающий,
 * который знает про объект, — здесь только правило.
 */
export function inScope(
  scope: Scope,
  ctx: { isCreator?: boolean; isAssignee?: boolean; inProject?: boolean; inDepartment?: boolean },
): boolean {
  switch (scope) {
    case 'all': return true;
    case 'created_by_me': return ctx.isCreator === true;
    case 'assigned': return ctx.isAssignee === true || ctx.isCreator === true;
    case 'project': return ctx.inProject === true;
    case 'department': return ctx.inDepartment === true;
    default: return false;
  }
}

/**
 * Потолок прав (ТЗ, п. 7).
 *
 * Тот, кто раздаёт права, не может выдать больше, чем есть у него самого, — иначе
 * ограничение администратора обходится в два нажатия: выдал себе право, снял
 * ограничение. Владелец — исключение: выше него в организации никого нет.
 */
export function capGrants(
  actorRole: string,
  actorPerms: PermissionMap,
  wanted: PermissionMap,
): { allowed: PermissionMap; refused: Permission[] } {
  if (actorRole === 'owner') return { allowed: wanted, refused: [] };
  const allowed: PermissionMap = {};
  const refused: Permission[] = [];
  for (const [key, grant] of Object.entries(wanted)) {
    if (!isPermission(key) || !grant) continue;
    // Отнять можно всегда — опасно только ДАВАТЬ то, чего у тебя нет.
    if (!grant.allowed || can(actorPerms, key)) allowed[key] = grant;
    else refused.push(key);
  }
  return { allowed, refused };
}

/** Политика организации: значения по умолчанию описывают сегодняшнее поведение. */
export interface SecurityPolicy {
  /** Двухфакторка: off | optional | required_for_admins | required_for_all. */
  twoFactor: 'off' | 'optional' | 'required_for_admins' | 'required_for_all';
  contacts: {
    /** Как показывать контакты по умолчанию: full | masked. */
    defaultAccess: 'full' | 'masked';
    /** Спрашивать причину при раскрытии. */
    requireReason: boolean;
    /** Через сколько секунд раскрытое снова прячется. */
    revealTtlSeconds: number;
  };
  tasks: {
    /** Кому разрешено удалять: по правам (`permission`) либо только владельцу. */
    deleteMode: 'permission' | 'owner_only';
    /** Не удалять завершённые: вместо удаления — архив. */
    protectClosed: boolean;
  };
  integrations: {
    /** all — можно любые, allow_list — только разрешённые владельцем, off — никакие. */
    mode: 'all' | 'allow_list' | 'off';
    allowList: string[];
  };
}

export const DEFAULT_POLICY: SecurityPolicy = {
  twoFactor: 'optional',
  contacts: { defaultAccess: 'masked', requireReason: false, revealTtlSeconds: 300 },
  tasks: { deleteMode: 'permission', protectClosed: false },
  integrations: { mode: 'all', allowList: [] },
};

/** Слить сохранённое с умолчаниями: в базе лежит только то, что меняли. */
export function mergePolicy(saved: unknown): SecurityPolicy {
  const s = (saved ?? {}) as Partial<SecurityPolicy>;
  return {
    twoFactor: s.twoFactor ?? DEFAULT_POLICY.twoFactor,
    contacts: { ...DEFAULT_POLICY.contacts, ...(s.contacts ?? {}) },
    tasks: { ...DEFAULT_POLICY.tasks, ...(s.tasks ?? {}) },
    integrations: { ...DEFAULT_POLICY.integrations, ...(s.integrations ?? {}) },
  };
}

/**
 * Замаскированное значение контакта.
 *
 * Показываем ровно столько, чтобы человек узнал знакомый номер и не путал записи:
 * начало и хвост. Середину не отдаём вовсе — ни в поле, ни в ответе сервера.
 */
export function maskContact(value: string | null | undefined, kind: 'phone' | 'email' | 'text'): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (kind === 'email') {
    const [name, domain] = raw.split('@');
    if (!domain) return `${raw.slice(0, 1)}•••`;
    return `${name.slice(0, 1)}•••@${domain}`;
  }
  if (kind === 'phone') {
    const digits = raw.replace(/\D/g, '');
    if (digits.length < 4) return '••••';
    return `${raw.slice(0, 2)}•••••${digits.slice(-2)}`;
  }
  return `${raw.slice(0, 1)}•••`;
}
