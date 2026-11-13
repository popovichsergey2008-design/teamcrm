/** «Пульс команды» #4890 — вызовы сервера (ленивый кусок: первый экран не утяжеляет). */
import { request } from '../../lib/api';

export interface Passport {
  metric: string; title: string; value: number; what: string; period: string; scope: string; updatedAt: string;
  related: { label: string; value: number | string }[];
  list: { label: string; count: number } | null;
}

export interface StepView {
  kind: 'nudge' | 'stale' | 'balance' | 'remind_review' | 'assign'; key: string; title: string; detail: string; effect: number; button: string;
  userId?: string | null; userName?: string | null; toId?: string | null; toName?: string | null; taskIds?: string[]; projectIds?: string[];
}

export interface FormulaPart { key: string; title: string; hint: string; weight: number; value: number; level: number; dynamics: number; cur: number; base: number }

export interface LoadRow {
  id: string; name: string; available: boolean; label: 'reviews' | 'overdue' | 'spare' | 'normal'; labelTitle: string;
  reviews: number; active: number; urgent: number; overdue: number; returned: number; submitted: number;
  hours: { estimated: number; withEstimate: number; total: number; available: number; line: string };
}

export interface ForecastRow {
  id: string; name: string; risk: 'risk' | 'attention' | null; remaining: number; perWeek: number; stuck: number; overdue: number;
  range: { kind: 'range' | 'approx'; from: string; to: string; text: string }; targetDate: string | null; late: number | null;
}

export interface MainCardView {
  kind: 'me' | 'other' | 'step' | 'none'; title: string; consequence: string; count: number;
  cost: { minutes: number; take: number } | null; effect: number;
  handoff: { fromId: string; toId: string; toName: string; count: number } | null;
  who: { id: string; name: string } | null; step?: StepView;
}

export interface TrialStepView { key: 'invite' | 'tasks' | 'reviewer' | 'close'; title: string; enables: string; done: boolean; progress: string }

export type PulseScreen = {
  generatedAt: string; mode: 'trial';
  trial: { steps: TrialStepView[]; done: number; trialDaysLeft: number | null };
  decisions: { count: number };
} | {
  generatedAt: string; mode: 'full';
  head: {
    score: number; display: number; zone: 'healthy' | 'normal' | 'risk' | 'help'; zoneTitle: string; headline: string; speed: string;
    trend7: number; series: number[]; velocity: { last7: number; prev7: number }; formula: { text: string; components: FormulaPart[] }; version: string;
  };
  main: MainCardView;
  decisions: { count: number; take: number; etaMin: number };
  steps: { top: StepView[]; total: number; groups: { key: string; userId: string | null; name: string; me: boolean; stepKey: string | null; count: number; items: { taskId: string; title: string; typeTitle: string; why: string; projectId: string; projectName: string; type: string }[] }[] };
  load: LoadRow[];
  forecast: { rows: ForecastRow[]; stale: { id: string; name: string }[]; noData: string[] };
  can: { act: boolean; rebalance: boolean; publish: boolean; editNorms: boolean };
};

export interface Prepared {
  recipient: { id: string; name: string }; kind: 'overdue' | 'review';
  tasks: { id: string; title: string; days: number }[]; available: { id: string; title: string; days: number }[];
  text: string; source: 'ai' | 'rules';
}

export interface Handoff {
  id: string; preview: string; from: { id: string; name: string }; to: { id: string; name: string };
  tasks: { id: string; title: string; days: number }[];
  before: { from: number; to: number }; after: { from: number; to: number };
  candidates: { id: string; name: string; queue: number }[];
}

export interface WeeklyPrefs { enabled: boolean; weekday: number; atTime: string }

/** Балансировка без процентов (п. 9): было → стало в задачах и в часах по оценкам. */
export interface Balance {
  id: string | null; fromName?: string; note?: string;
  fromActive: number; fromOverdue: number; fromHours: number; fromEstimated: number;
  items: { taskId: string; title: string; cost: number; hours: number | null; deadlineAt: string | null; priority: string; toId: string | null; reason: string | null; allowedIds: string[] | null }[];
  people: { id: string; name: string; available: boolean; active: number; hours: number; estimated: number }[];
}

const tz = () => encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone || '');

export const pulseApi = {
  screen: () => request<PulseScreen>('GET', `/radar/pulse?tz=${tz()}`),
  passport: (metric: string) => request<Passport>('GET', `/radar/passport/${metric}`),
  prepare: (b: { userId: string; kind: 'overdue' | 'review'; taskIds?: string[] }) => request<Prepared>('POST', '/radar/message/prepare', b),
  send: (b: { userId: string; kind: 'overdue' | 'review'; taskIds: string[]; text: string }) => request<{ chatId: string; marked: number }>('POST', '/radar/message/send', b),
  handoff: (b: { fromId: string; toId?: string | null; count?: number }) => request<Handoff>('POST', '/radar/handoff/preview', b),
  confirm: (id: string, moves?: { taskId: string; toId: string | null }[]) => request<{ status: string; text: string }>('POST', `/radar/actions/${id}/confirm`, moves ? { moves } : {}),
  balance: (userId: string, b: { taskIds?: string[]; toId?: string | null } = {}) => request<Balance>('POST', `/radar/rebalance/${userId}/preview`, b),
  reject: (id: string) => request<{ status: string }>('POST', `/radar/actions/${id}/reject`, {}),
  weeklyPrefs: () => request<WeeklyPrefs>('GET', '/radar/weekly/prefs'),
  saveWeekly: (b: Partial<WeeklyPrefs>) => request<WeeklyPrefs>('PATCH', '/radar/weekly/prefs', b),
  weeklyPreview: () => request<{ text: string; link: string }>('GET', '/radar/weekly/preview'),
  event: (kind: 'weekly_open' | 'run_started' | 'run_finished' | 'passport_opened' | 'action', ref?: string) =>
    request<{ ok: boolean }>('POST', '/radar/events', { kind, ref: ref ?? null }),
};

/** «индекс +4», «индекс +0,6» — дробь, только если целое не меняется. */
export const effectText = (e: number) => {
  const r = Math.round(e * 10) / 10;
  const s = Math.abs(r) >= 1 ? String(Math.round(r)) : String(r).replace('.', ',');
  return r > 0 ? `+${s}` : r < 0 ? s : '±0';
};

/** Индекс «было → стало»: дробная часть — когда целое не поменялось (одно решение двигает индекс на десятые). */
export const indexPair = (before: number, after: number) => {
  const same = Math.round(before) === Math.round(after);
  const f = (v: number) => (same ? (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') : String(Math.round(v)));
  return `${f(before)} → ${f(after)}`;
};
