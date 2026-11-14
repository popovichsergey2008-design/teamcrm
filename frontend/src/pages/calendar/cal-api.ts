/**
 * Календарь #4892 — вызовы сервера. Отдельно от общего api.ts: страница календаря
 * ленивая, и эти функции не должны утяжелять первый экран.
 */
import { request } from '../../lib/api';

export interface CalPrefs {
  workStart: string; workEnd: string; lunchStart: string | null; lunchEnd: string | null; ownHours: boolean;
  timeZone: string; focusGoalMin: number; chatSuggest: boolean; prepMin: number; onboarded: boolean; dismissed: string[];
  connected: { google: boolean; yandex: boolean; ics: boolean; any: boolean };
  company: { workStart: string; workEnd: string; weekendDays: number[] };
}
export interface PreviewRow { label: string; before: string; after: string }
export interface Suggestion {
  key: string; kind: 'overlap' | 'heavy_day' | 'buffers' | 'focus_window' | 'agenda';
  tone: 'danger' | 'warn' | 'ok' | 'plain'; title: string; text: string;
  action: { label: string; kind: string }; preview: PreviewRow[];
  slot?: { startsAt: string; endsAt: string }; window?: { startsAt: string; endsAt: string };
}
export interface WeekAssistant {
  insight: { meetingMin: number; workMin: number; meetingText: string; overlaps: number; backToBack: number; focusWindows: number; windows: { startsAt: string; endsAt: string }[] };
  suggestions: Suggestion[];
}
export interface BestSlot { startsAt: string; endsAt: string; best: boolean; reasons: string[]; busyOptional: string[]; label: string }
export interface BestTimeResult {
  minutes: number; timeZone: string; message: string | null; slots: BestSlot[];
  day: { startsAt: string; endsAt: string; label: string };
  people: { id: string; name: string; me: boolean; optional: boolean; zone: string | null; bar: { kind: 'meeting' | 'focus' | 'lunch' | 'off'; startsAt: string; endsAt: string }[] }[];
}
export interface PhrasePreview {
  title: string; topic: string | null; allDay: boolean; location: string | null; repeat: string | null; timeGuessed: boolean;
  startsAt: string | null; endsAt: string | null; people: { id: string; name: string }[];
  allFree: boolean; busy: string[]; suggestion: { startsAt: string; endsAt: string; label: string } | null; call: boolean;
  agenda: { id: string; title: string; projectId: string; overdueDays: number | null }[];
}
export interface CallItem { id: string; title: string; startsAt: string; endsAt: string; live: boolean; chatId: string | null; roomId: string; participants: number; meetingId: string | null; summaryReady: boolean }
/** #4920, п. 4: карточка созвона из журнала. */
export interface CallCardTask { title: string; assignee: string | null; deadlineAt: string | null; taskId: string | null; projectId: string | null; done: boolean }
export interface CallCardData {
  id: string; title: string; startsAt: string; endsAt: string; live: boolean; roomId: string; chatId: string | null; chatTitle: string | null;
  people: string[];
  meeting: { id: string; status: string | null; summary: string | null; decisions: string[]; tasks: CallCardTask[] } | null;
  previous: { meetingId: string; title: string; happenedAt: string; agreements: CallCardTask[] } | null;
  materials: { fileId: string; title: string }[];
}
export interface PrepCard {
  eventId: string; title: string; startsAt: string; endsAt: string; canEdit: boolean; people: string[];
  publicId: string | null; meetRoomId: string | null;
  agenda: { body: string; auto: boolean; sentAt: string | null; source: string } | null;
  previous: { meetingId: string; title: string; date: string; items: { title: string; assignee: string | null; deadlineAt: string | null; done: boolean; taskId: string | null; projectId: string | null }[] } | null;
  materials: { kind: 'doc' | 'protocol' | 'task'; title: string; url?: string | null; meetingId?: string; taskId?: string; projectId?: string; hint?: string }[];
  prepMin: number;
}

export const calApi = {
  prefs: () => request<CalPrefs>('GET', '/calendar/plus/prefs'),
  event: (id: string) => request<unknown>('GET', `/calendar/events/${id}`),
  savePrefs: (b: Partial<{ workStart: string | null; workEnd: string | null; lunchStart: string | null; lunchEnd: string | null; timeZone: string; focusGoalMin: number; chatSuggest: boolean; prepMin: number; onboarded: boolean }>) =>
    request<CalPrefs>('PATCH', '/calendar/plus/prefs', b),
  assistant: (from: string, to: string) => request<WeekAssistant>('GET', `/calendar/plus/assistant?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  apply: (key: string, from: string, to: string) => request<{ applied: string }>('POST', '/calendar/plus/assistant/apply', { key, from, to }),
  dismiss: (key: string) => request<{ dismissed: string }>('POST', '/calendar/plus/assistant/dismiss', { key }),
  bestTime: (b: { participantIds: string[]; optionalIds?: string[]; minutes: number; exceptEventId?: string; days?: number }) =>
    request<BestTimeResult>('POST', '/calendar/plus/best-time', b),
  phrase: (text: string) => {
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const now = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return request<PhrasePreview>('POST', '/calendar/plus/phrase', { text, now, offset: d.getTimezoneOffset() });
  },
  create: (b: { title: string; startsAt: string; endsAt: string; participantIds?: string[]; description?: string; repeat?: string | null; via: string; agendaTaskIds?: string[]; allDay?: boolean; location?: string | null }) =>
    request<{ id: string; meeting?: { publicId: string } | null }>('POST', '/calendar/plus/events', { ...b, repeat: b.repeat || undefined, location: b.location || undefined }),
  calls: (from: string, to: string) => request<CallItem[]>('GET', `/calendar/plus/calls?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  callCard: (id: string) => request<CallCardData>('GET', `/calendar/plus/calls/${encodeURIComponent(id)}/card`),
  prep: (id: string) => request<PrepCard>('GET', `/calendar/plus/events/${id}/prep`),
  genAgenda: (id: string, save: boolean) => request<{ body: string }>('POST', `/calendar/plus/events/${id}/agenda/generate${save ? '?save=1' : ''}`),
  saveAgenda: (id: string, body: string) => request<PrepCard>('PUT', `/calendar/plus/events/${id}/agenda`, { body }),
  sendAgenda: (id: string) => request<{ sent: number }>('POST', `/calendar/plus/events/${id}/agenda/send`),
  yandex: () => request<{ login: string; calendar_title: string | null; last_sync_at: string | null; last_error: string | null } | null>('GET', '/calendar/plus/yandex'),
  connectYandex: (login: string, password: string) => request<{ connected: boolean; calendar: string | null }>('POST', '/calendar/plus/yandex', { login, password }),
  disconnectYandex: () => request<{ disconnected: boolean }>('DELETE', '/calendar/plus/yandex'),
};

export const hhmm = (iso: string) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
export const dayLabel = (iso: string) => {
  const d = new Date(iso);
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() - t0.getTime()) / 86_400_000);
  if (diff === 0) return 'сегодня';
  if (diff === 1) return 'завтра';
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
};
