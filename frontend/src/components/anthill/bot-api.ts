/** QEVO Bot #4893 — вызовы для стартового экрана и каталога (ленивый кусок, не в api.ts). */
import { request } from '../../lib/api';

export type CardAction =
  | { kind: 'prompt'; prompt: string }
  | { kind: 'review' }
  | { kind: 'voice' }
  | { kind: 'link'; href: string }
  | { kind: 'connect'; source: 'calendar' | 'mail' };
export interface StartCard { id: string; text: string; button: string; action: CardAction }
export interface StartScreen {
  cards: StartCard[]; example: string; web: boolean; tz: string | null;
  connections: { mail: boolean; calendar: boolean; telegram: boolean };
}

export const botApi = {
  start: () => request<StartScreen>('GET', '/anthill/start'),
  popular: () => request<{ id: string; n: number }[]>('GET', '/anthill/scenarios/popular'),
  ran: (id: string) => request<{ ok: boolean }>('POST', `/anthill/scenarios/${id}/run`),
  schedulePreview: (schedule: string) => request<{ label: string; firstRun: string; tz: string }>('POST', '/anthill/schedules/preview', { schedule }),
  addSchedule: (i: { title: string; instruction: string; schedule: string }) => request<{ id: string }>('POST', '/anthill/schedules', i),
};
