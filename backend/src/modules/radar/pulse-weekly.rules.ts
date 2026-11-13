/**
 * «Пульс недели» в Telegram (#4890, п. 12) — текст сводки и правило «пора ли отправлять».
 */

export interface WeeklyPrefs { enabled: boolean; weekday: number; atTime: string }
export const WEEKLY_DEFAULT: WeeklyPrefs = { enabled: true, weekday: 1, atTime: '09:00' };

const fmt = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

/** Местное время человека попало в окно отправки (два часа после назначенного), сегодня его день недели. */
export function dueNow(p: WeeklyPrefs, local: { weekday: number; minutes: number }): boolean {
  if (!p.enabled || local.weekday !== p.weekday) return false;
  const [h, m] = p.atTime.split(':').map(Number);
  const at = (h || 0) * 60 + (m || 0);
  return local.minutes >= at && local.minutes < at + 120;
}

export function weeklyText(i: {
  team: string; score: number; trend: number; speed: string;
  main: string | null; steps: { title: string; effect: number }[];
}): string {
  const arrow = i.trend > 0 ? `▲ +${fmt(i.trend)}` : i.trend < 0 ? `▼ ${fmt(i.trend)}` : '= 0';
  const lines = [
    `Пульс недели · ${i.team}`,
    '',
    `Индекс: ${Math.round(i.score)} (${arrow} за неделю)`,
  ];
  if (i.speed) lines.push(`${i.speed.charAt(0).toUpperCase()}${i.speed.slice(1)}.`);
  if (i.main) lines.push('', `Главное: ${i.main}`);
  if (i.steps.length) {
    lines.push('', '3 шага на эту неделю:');
    i.steps.slice(0, 3).forEach((s, k) => lines.push(`${k + 1}. ${s.title}${s.effect > 0 ? ` — индекс +${fmt(s.effect)}` : ''}`));
  }
  return lines.join('\n');
}
