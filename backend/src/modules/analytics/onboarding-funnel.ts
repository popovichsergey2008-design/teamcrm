/**
 * Воронка онбординга и продуктовые метрики (ТЗ-11, разд. 56-57).
 *
 * Считаются ПО ФАКТАМ, а не по отметкам о событиях: когда заведён первый проект, когда
 * появилась первая задача, когда пришёл второй человек. Отдельной таблицы событий нет и
 * не заводим — по тем же причинам, по которым у шагов онбординга нет галочек: две записи
 * об одном и том же расходятся на первой же неделе, и потом не понять, какой верить.
 * Заодно воронка считается задним числом — по организациям, заведённым до этого этапа.
 *
 * Чего здесь НЕТ. `signup_started` из ТЗ (человек открыл форму регистрации) не меряем:
 * до регистрации на сервере нет ничего, а открытая ручка «я начал регистрацию» даёт
 * число, которое кто угодно накрутит одной строкой в консоли браузера. Воронка
 * начинается с того, что действительно произошло, — с созданного пространства.
 */

export const FUNNEL_STEPS = [
  'workspace', 'company', 'telegram', 'department',
  'invite', 'member', 'project', 'task', 'completed',
] as const;

export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export const STEP_TITLES: Record<FunnelStep, string> = {
  workspace: 'Пространство создано',
  company: 'Компания настроена',
  telegram: 'Telegram подключён',
  department: 'Появился первый отдел',
  invite: 'Отправлено приглашение',
  member: 'Пришёл второй человек',
  project: 'Создан первый проект',
  task: 'Создана первая задача',
  completed: 'Путь пройден',
};

/** Когда с организацией впервые случилось каждое из событий воронки. */
export interface TenantMilestones {
  tenantId: string;
  name: string;
  createdAt: Date;
  companyAt: Date | null;
  telegramAt: Date | null;
  departmentAt: Date | null;
  inviteAt: Date | null;
  memberAt: Date | null;
  projectAt: Date | null;
  taskAt: Date | null;
  completedAt: Date | null;
  invitesSent: number;
  invitesAccepted: number;
  voiceJobs: number;
}

export function stepsOf(m: TenantMilestones): Record<FunnelStep, Date | null> {
  return {
    workspace: m.createdAt,
    company: m.companyAt,
    telegram: m.telegramAt,
    department: m.departmentAt,
    invite: m.inviteAt,
    member: m.memberAt,
    project: m.projectAt,
    task: m.taskAt,
    completed: m.completedAt,
  };
}

/** Сколько прошло от создания пространства до события. null — события не было. */
function since(from: Date, to: Date | null): number | null {
  if (!to) return null;
  const ms = to.getTime() - from.getTime();
  // Отрицательное время означает разъехавшиеся часы или правку данных руками: в
  // медиану такое пускать нельзя, честнее считать, что мерить нечего.
  return ms >= 0 ? ms : null;
}

/**
 * Продуктовые метрики одной организации.
 *
 * «Первая польза» — это первая заведённая задача. Не проект: пустой проект ничего не
 * меняет в работе, а задача — уже работа.
 */
export interface TenantDurations {
  toInvite: number | null;
  toProject: number | null;
  toTask: number | null;
  /** До совместной работы: в пространстве появился второй человек. */
  toCollaboration: number | null;
  /** Главная метрика ТЗ: Time to First Value. */
  toValue: number | null;
}

export function durationsOf(m: TenantMilestones): TenantDurations {
  return {
    toInvite: since(m.createdAt, m.inviteAt),
    toProject: since(m.createdAt, m.projectAt),
    toTask: since(m.createdAt, m.taskAt),
    toCollaboration: since(m.createdAt, m.memberAt),
    toValue: since(m.createdAt, m.taskAt),
  };
}

/**
 * Медиана, а не среднее.
 *
 * Одна организация, которая завела задачу через полгода, сдвигает среднее так, что
 * смотреть на него бессмысленно. Медиана отвечает на вопрос, который и задают: за
 * сколько доходит обычный клиент.
 */
export function median(values: number[]): number | null {
  const ok = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (ok.length === 0) return null;
  const mid = ok.length >> 1;
  return ok.length % 2 ? ok[mid] : Math.round((ok[mid - 1] + ok[mid]) / 2);
}

export interface FunnelSummary {
  tenants: number;
  steps: { key: FunnelStep; title: string; count: number; share: number }[];
  medians: TenantDurations;
  /** Доля организаций, дошедших до конца пути. */
  completionRate: number;
  /** Доля приглашений, которыми воспользовались. null — приглашений не было вовсе. */
  inviteAcceptance: number | null;
  /** Доля организаций, где хоть раз диктовали голосом. */
  voiceAdoption: number;
}

const share = (part: number, whole: number): number => (whole > 0 ? Math.round((part / whole) * 1000) / 1000 : 0);

/**
 * Свод по всем организациям.
 *
 * Шаги НЕ считаются «через предыдущий»: проект заводят, не создав ни одного отдела, и
 * это нормально. Каждое число отвечает на свой вопрос — у скольких организаций это
 * вообще случилось, — а не «сколько просочилось через горлышко».
 */
export function summarize(list: TenantMilestones[]): FunnelSummary {
  const total = list.length;
  const all = list.map(stepsOf);

  const steps = FUNNEL_STEPS.map((key) => {
    const count = all.filter((s) => !!s[key]).length;
    return { key, title: STEP_TITLES[key], count, share: share(count, total) };
  });

  const d = list.map(durationsOf);
  const pick = (f: (x: TenantDurations) => number | null) =>
    median(d.map(f).filter((v): v is number => v !== null));

  const sent = list.reduce((s, m) => s + m.invitesSent, 0);
  const accepted = list.reduce((s, m) => s + m.invitesAccepted, 0);

  return {
    tenants: total,
    steps,
    medians: {
      toInvite: pick((x) => x.toInvite),
      toProject: pick((x) => x.toProject),
      toTask: pick((x) => x.toTask),
      toCollaboration: pick((x) => x.toCollaboration),
      toValue: pick((x) => x.toValue),
    },
    completionRate: share(list.filter((m) => !!m.completedAt).length, total),
    inviteAcceptance: sent > 0 ? share(accepted, sent) : null,
    voiceAdoption: share(list.filter((m) => m.voiceJobs > 0).length, total),
  };
}
