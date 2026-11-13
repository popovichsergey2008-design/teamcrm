import {
  decisionsPassport, etaMinutes, nextBatch, openQuestionsOf, QueueItem, queueStats, recapByRules, recapIsGrounded, waitingTitle,
} from './decision-queue.rules';

const now = new Date('2026-11-13T10:00:00Z');
const item = (id: string, daysAgo: number, extra: Partial<QueueItem> = {}): QueueItem => ({
  key: `review:${id}`, kind: 'review', taskId: id, approvalId: null, title: `Задача ${id}`, projectId: '1', projectName: 'QEVO',
  assigneeId: `u${id}`, assigneeName: 'Глеб', since: new Date(now.getTime() - daysAgo * 86_400_000), deadlineAt: null, priority: 'normal', ...extra,
});

describe('очередь «ждут вашего решения» (#4890, пп. 3–6)', () => {
  it('пачка — 10 самых старых; пропущенная остаётся в очереди', () => {
    const items = Array.from({ length: 15 }, (_, i) => item(String(i + 1), i));
    const b = nextBatch(items, new Set());
    expect(b).toHaveLength(10);
    expect(b[0].taskId).toBe('15'); // ждёт дольше всех
    // «Пропустить» исключает задачу только из ЭТОЙ пачки — в очереди (items) она остаётся
    const again = nextBatch(items, new Set(['review:15']));
    expect(again[0].taskId).toBe('14');
    expect(items.some((i) => i.key === 'review:15')).toBe(true);
  });

  it('сводка: число = длина списка, срок прошёл, кто ждёт', () => {
    const items = [item('1', 34, { deadlineAt: new Date('2026-10-05T00:00:00Z') }), item('2', 3), item('3', 1, { assigneeId: 'u1' })];
    const s = queueStats(items, now);
    expect(s.count).toBe(3);
    expect(s.overdue).toBe(1);
    expect(s.oldestDays).toBe(34);
    expect(s.projects).toEqual(['QEVO']);
  });

  it('паспорт числа: что считается, период, связанные числа, «Открыть список» с тем же числом', () => {
    const p = decisionsPassport({ count: 81, reviews: 78, approvals: 3, overdue: 68, teamReview: 188, projects: 10, updatedAt: now });
    expect(p.title).toBe('81 задача ждёт вашей проверки');
    expect(p.period).toMatch(/^Сейчас/);
    expect(p.list).toEqual({ label: 'Открыть список', count: 81 });
    expect(p.related.find((r) => r.label === 'из них срок прошёл')?.value).toBe(68);
    expect(p.related.find((r) => r.label === 'у всей команды на проверке')?.value).toBe(188);
  });

  it('10 решений ≈ 20 минут; заголовок от второго лица', () => {
    expect(etaMinutes(10)).toBe(20);
    expect(waitingTitle(1)).toBe('1 задача ждёт вашей проверки');
    expect(waitingTitle(3)).toBe('3 задачи ждут вашей проверки');
  });

  it('п. 5: пересказ только из фактов; нет данных — так и пишем', () => {
    const empty = { files: [], checklist: { total: 0, done: 0 }, comments: 0, openQuestions: 0, questionsToReviewer: 0 };
    expect(recapByRules(empty)).toBe('Вложений нет, чек-листа нет, комментариев нет.');
    const full = { files: [{ name: 'отчёт.pdf', type: 'application/pdf' }], checklist: { total: 12, done: 12 }, comments: 4, openQuestions: 0, questionsToReviewer: 0 };
    expect(recapByRules(full)).toContain('отмечено 12 из 12');
    expect(recapIsGrounded('Приложен отчёт (PDF), 12 из 12 пунктов чек-листа отмечены, открытых вопросов нет.', full)).toBe(true);
    // число, которого нет в задаче, — выдумка
    expect(recapIsGrounded('Приложено 6 страниц отчёта.', full)).toBe(false);
    expect(recapIsGrounded('Приложены два скриншота.', empty)).toBe(false);
  });

  it('открытые вопросы: без ответа другого человека; заданные исполнителем — к проверяющему', () => {
    const q = openQuestionsOf([
      { authorId: 'a', body: 'Готово, посмотришь?' },
      { authorId: 'b', body: 'Да, завтра' },
      { authorId: 'a', body: 'А макет нужен?' },
    ], 'a');
    expect(q).toEqual({ open: 1, toReviewer: 1 });
  });
});
