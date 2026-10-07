import { Permission } from '../security/permissions';

/**
 * Правила для каждого инструмента QEVO Bot (ТЗ-18, §5 и §16).
 *
 * Раньше у инструмента было только «читает / пишет». Этого мало, чтобы решить три
 * вопроса перед действием: какое право должно быть у человека, насколько опасно
 * действие и задевает ли оно других людей. Ответы живут здесь, одной таблицей, —
 * чтобы их можно было прочитать глазами и проверить тестом, а не искать по 28
 * инструментам.
 */

/** Уровень риска (§5). FINANCIAL и LEGAL появятся вместе с такими инструментами. */
export type Risk = 'read' | 'low_write' | 'high_write' | 'destructive';

/** Группа действий — по ней владелец задаёт автономность (§4). */
export type ToolGroup = 'read' | 'self' | 'tasks' | 'messages' | 'calendar' | 'documents';
export type WriteGroup = Exclude<ToolGroup, 'read'>;

/**
 * Режим автономности группы.
 *
 * Пять уровней ТЗ (DISABLED · SUGGEST · DRAFT · CONFIRM_BEFORE_ACTION · AUTO) у нас
 * сходятся в четыре: карточка бота — это и есть черновик, который человек правит и
 * подтверждает, поэтому DRAFT и CONFIRM — одно и то же.
 */
export type AutonomyMode = 'off' | 'suggest' | 'confirm' | 'auto';
export type Autonomy = Record<WriteGroup, AutonomyMode>;

export const WRITE_GROUPS: WriteGroup[] = ['self', 'tasks', 'messages', 'calendar', 'documents'];

/**
 * По умолчанию всё — с подтверждением, кроме того, что касается только самого
 * человека: напоминание себе или запись в память удобнее получить сразу, а
 * «Отменить» под ними остаётся.
 */
export const DEFAULT_AUTONOMY: Autonomy = {
  self: 'auto', tasks: 'confirm', messages: 'confirm', calendar: 'confirm', documents: 'confirm',
};

type Params = Record<string, unknown>;

export interface ToolPolicy {
  risk: Risk;
  group: ToolGroup;
  /** Какое право нужно человеку. Функция — когда право зависит от того, куда направлено действие. */
  permission?: Permission | ((p: Params) => Permission | null);
  /**
   * Задевает ли действие других людей: чужая задача, сообщение коллеге, встреча с
   * участниками. Такое никогда не выполняется само — решение заказчика 07.10.
   */
  affectsOthers: boolean | ((p: Params) => boolean);
}

const READ: ToolPolicy = { risk: 'read', group: 'read', affectsOthers: false };

export const TOOL_POLICY: Record<string, ToolPolicy> = {
  search_tasks: { ...READ, permission: 'task.view' },
  get_task: { ...READ, permission: 'task.view' },
  search_clients: { ...READ, permission: 'client.view' },
  client_overview: { ...READ, permission: 'client.view' },
  search_messages: { ...READ, permission: 'chat.view' },
  chat_recent: { ...READ, permission: 'chat.view' },
  whats_missed: { ...READ, permission: 'chat.view' },
  get_project: { ...READ, permission: 'project.view' },
  search_meetings: READ,
  get_meeting: READ,
  team_status: { ...READ, permission: 'task.view' },
  global_search: READ,
  how_to: READ,
  web_search: READ,
  list_files: { ...READ, permission: 'file.download' },
  read_file: { ...READ, permission: 'file.download' },
  find_slots: READ,
  my_day: READ,
  time_audit: READ,
  my_events: READ,

  create_reminder: { risk: 'low_write', group: 'self', affectsOthers: false },
  create_scheduled_task: { risk: 'low_write', group: 'self', affectsOthers: false },
  create_skill: { risk: 'low_write', group: 'self', affectsOthers: false },
  remember: { risk: 'low_write', group: 'self', affectsOthers: false },

  create_task: { risk: 'high_write', group: 'tasks', permission: 'task.create', affectsOthers: true },
  update_task: {
    risk: 'high_write', group: 'tasks',
    permission: (p) => (p.assigneeId ? 'task.assign' : 'task.edit'),
    affectsOthers: true,
  },
  add_comment: { risk: 'high_write', group: 'messages', permission: 'chat.write', affectsOthers: true },
  send_message: { risk: 'high_write', group: 'messages', permission: 'chat.write', affectsOthers: true },
  create_event: {
    risk: 'high_write', group: 'calendar',
    // встреча без участников — это время в своём календаре, а не приглашение
    affectsOthers: (p) => Array.isArray(p.participantIds) && p.participantIds.length > 0,
  },
  move_event: {
    risk: 'high_write', group: 'calendar',
    affectsOthers: (p) => Number(p.participants ?? 0) > 0,
  },
  // отмену не вернуть: встреча удаляется, участникам уходит отмена
  cancel_event: { risk: 'destructive', group: 'calendar', affectsOthers: true },
  create_document: {
    risk: 'low_write', group: 'documents',
    permission: (p) => (p.target === 'task' ? 'task.edit' : p.target === 'chat' ? 'chat.write' : null),
    affectsOthers: (p) => p.target === 'task' || p.target === 'chat',
  },
};

/**
 * Правило инструмента. Неизвестный инструмент — самый строгий случай: лучше лишний
 * раз спросить, чем молча выполнить то, о чём таблица не знает.
 */
export function policyOf(tool: string): ToolPolicy {
  return TOOL_POLICY[tool] ?? { risk: 'high_write', group: 'tasks', affectsOthers: true };
}

export function permissionFor(tool: string, params: Params): Permission | null {
  const p = policyOf(tool).permission;
  if (!p) return null;
  return typeof p === 'function' ? p(params) : p;
}

export function affectsOthers(tool: string, params: Params): boolean {
  const a = policyOf(tool).affectsOthers;
  return typeof a === 'function' ? a(params) : a;
}

const RISK_ORDER: Risk[] = ['read', 'low_write', 'high_write', 'destructive'];

export function maxRisk(list: Risk[]): Risk {
  return list.reduce<Risk>((acc, r) => (RISK_ORDER.indexOf(r) > RISK_ORDER.indexOf(acc) ? r : acc), 'read');
}

/** Настройка организации поверх значений по умолчанию; мусор в базе — значение по умолчанию. */
export function autonomyOf(saved: Record<string, unknown> | null | undefined): Autonomy {
  const out = { ...DEFAULT_AUTONOMY };
  for (const g of WRITE_GROUPS) {
    const v = saved?.[g];
    if (v === 'off' || v === 'suggest' || v === 'confirm' || v === 'auto') out[g] = v;
  }
  return out;
}

/**
 * Как поступить с конкретным действием.
 *
 * Потолок зашит здесь, а не в настройке: что задевает других, само не выполняется
 * никогда — даже если в группе стоит «auto». Разрушительное — тоже. Настройку можно
 * только ужесточить, но не ослабить ниже правила.
 */
export function decide(tool: string, params: Params, autonomy: Autonomy): AutonomyMode {
  const pol = policyOf(tool);
  if (pol.group === 'read') return 'auto';
  const mode = autonomy[pol.group];
  if (mode === 'auto' && (affectsOthers(tool, params) || pol.risk === 'destructive')) return 'confirm';
  return mode;
}
