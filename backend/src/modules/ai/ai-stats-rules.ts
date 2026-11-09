/**
 * Строка пользы ИИ (#4807 §7): «сегодня: 12 задач · 3 протокола».
 *
 * Считается только подтверждённое и только своё; нули не показываем; больше двух
 * показателей в строку не ставим. Чистые функции — их проверяют тесты.
 */
export interface AiCounts { tasks: number; protocols: number; items: number; dayPlan: number; mails: number }

const plural = (n: number, one: string, few: string, many: string) => {
  const m10 = n % 10; const m100 = n % 100;
  return m10 === 1 && m100 !== 11 ? one : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? few : many;
};

/** Показатели с подписью, по убыванию; нулевые — выкинуты. «План дня» — без числа. */
export function aiParts(c: AiCounts): { n: number; text: string }[] {
  const parts = [
    { n: c.tasks, text: `${c.tasks} ${plural(c.tasks, 'задача', 'задачи', 'задач')}` },
    { n: c.protocols, text: `${c.protocols} ${plural(c.protocols, 'протокол', 'протокола', 'протоколов')}` },
    { n: c.items, text: `${c.items} ${plural(c.items, 'поручение', 'поручения', 'поручений')}` },
    { n: c.mails, text: `${c.mails} ${plural(c.mails, 'письмо', 'письма', 'писем')}` },
    { n: c.dayPlan ? 1 : 0, text: 'план дня' },
  ];
  return parts.filter((p) => p.n > 0).sort((a, b) => b.n - a.n);
}

/** Максимум два самых больших показателя: «12 задач · 3 протокола». Пусто — ''. */
export function aiLine(c: AiCounts): string {
  return aiParts(c).slice(0, 2).map((p) => p.text).join(' · ');
}

const HINTS = ['Попробуйте: задача из сообщения', 'Попробуйте: задача из голоса', 'Попробуйте: протокол созвона', 'Попробуйте: план дня'];

/** За сегодня ничего — подсказка, чередуется по дням; после 3 дней с ИИ — не показываем. */
export function aiHint(c: AiCounts, usedDays: number, day: Date): string {
  if (aiLine(c) || usedDays >= 3) return '';
  return HINTS[Math.floor(day.getTime() / 86_400_000) % HINTS.length];
}

/** Подсказка при наведении: разбивка за сегодня и за 7 дней. */
export function aiTip(today: AiCounts, week: AiCounts): string {
  const all = (c: AiCounts) => aiParts(c).map((p) => p.text).join(', ') || 'пока ничего';
  return `Сегодня: ${all(today)}\n7 дней: ${all(week)}\nНажмите — журнал действий ИИ`;
}
