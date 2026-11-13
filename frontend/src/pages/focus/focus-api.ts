/** «Фокус дня» #4891 — вызовы сервера (страница ленивая, первый экран не утяжеляет). */
import { request } from '../../lib/api';

export interface DaySlot {
  kind: 'meeting' | 'task' | 'reviews' | 'reserve' | 'lunch'; title: string; startsAt: string; endsAt: string;
  itemId?: string; taskId?: string | null; estimated?: boolean; count?: number;
}
export interface MainCard {
  itemId: string; taskId: string | null; projectId: string | null; projectName: string | null; title: string | null; kind: string;
  position: number; of: number; deadlineAt: string | null; nextStep: string | null; result: string | null;
  estimate: { minutes: number; source: 'task' | 'ai' } | null;
}
export interface PlusDay {
  enabled: true; updatedAt: string; phase: 'morning' | 'day' | 'evening'; dayOff: boolean;
  nextWorkday: { date: string; label: string } | null; date: string; timeZone: string; workStart: string; workEnd: string;
  capacity: { workMin: number; meetingMin: number; availableMin: number; plannedMin: number; reviewsMin: number; reserveMin: number; overloadMin: number };
  timeline: DaySlot[];
  brief: { yesterday: string | null; text: string };
  decisions: number; waitingReview: number;
  why: { rank: number; title: string; reasons: string[]; deadline: string }[];
  notIncluded: { title: string; why: string }[];
  overload: { itemId: string; taskId: string | null; title: string; minutes: number; startsAt: string; endsAt: string; label: string } | null;
  overdue: { id: string; title: string; days: number; estimate_min: number | null; project_id: string }[];
  main: MainCard | null;
  progress: { done: number; total: number; deepMin: number };
}
export interface TaskNote { nextStep: string | null; nextStepSource: 'saved' | 'checklist' | null; result: string | null; stepsDone: string[]; aiEstimateMin: number | null }

export const focusApi = {
  day: () => request<PlusDay | { enabled: false }>('GET', '/focus/plus/day'),
  accept: () => request<PlusDay>('POST', '/focus/plus/accept'),
  acceptAnyway: () => request<PlusDay>('POST', '/focus/plus/accept-anyway'),
  overload: () => request<PlusDay>('POST', '/focus/plus/overload/apply'),
  overduePreview: () => request<{ placements: { taskId: string; title: string; startsAt: string; endsAt: string; label: string }[] }>('POST', '/focus/plus/overdue/preview'),
  overdueApply: (placements: { taskId: string; startsAt: string; endsAt: string }[]) => request<{ planned: number }>('POST', '/focus/plus/overdue/apply', { placements }),
  suggest: (taskId: string) => request<{ minutes: number; source: string }>('POST', `/focus/plus/tasks/${taskId}/estimate/suggest`),
  confirm: (taskId: string, minutes: number) => request<{ minutes: number }>('POST', `/focus/plus/tasks/${taskId}/estimate`, { minutes }),
  note: (taskId: string) => request<TaskNote>('GET', `/focus/plus/tasks/${taskId}/note`),
  saveNote: (taskId: string, b: { nextStep?: string | null; result?: string | null; stepDone?: string | null }) => request<TaskNote>('PUT', `/focus/plus/tasks/${taskId}/note`, b),
  snooze: (key: string, until: string, remind = false) => request<{ snoozed: string }>('POST', '/focus/plus/snooze', { key, until, remind }),
  snoozed: () => request<{ item_key: string; until: string }[]>('GET', '/focus/plus/snoozed'),
  extend: (sessionId: string, minutes = 10) => request<{ extended: number }>('POST', `/focus/plus/sessions/${sessionId}/extend`, { minutes }),
  afterDone: (taskId: string | null, minutes: number) => request<{ minutes: number; progress: { done: number; total: number; deepMin: number }; notified: string | null; next: { itemId: string; taskId: string | null; title: string | null } | null } | null>('POST', '/focus/plus/after-done', { taskId, minutes }),
};

export const hm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
export const dur = (min: number) => {
  const h = Math.floor(min / 60); const m = min % 60;
  return h && m ? `${h} ч ${m} мин` : h ? `${h} ч` : `${m} мин`;
};
