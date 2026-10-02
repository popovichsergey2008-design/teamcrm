import { buildTaskReport, periodLabel, ReportInput, ReportTaskRow } from './task-report.model';
import { renderTaskReportHtml } from './task-report.html';
import { ReportsService } from './reports.service';

/**
 * Отчёт по задачам: правила счёта.
 *
 * Отчёт уходит руководителю и клиенту — ошибка в нём стоит доверия ко всей системе.
 * Поэтому проверяем ровно то, о чём спорят: что «в срок», что «просрочено на конец
 * периода», и что задачи без срока не делают процент лучше.
 */
const MSK = 'Europe/Moscow';
const at = (s: string) => new Date(s);
const start = at('2026-08-31T21:00:00Z'); // 1 сентября 00:00 МСК
const end = at('2026-09-30T21:00:00Z'); // 1 октября 00:00 МСК
const prevStart = at('2026-08-01T21:00:00Z');

let seq = 0;
const task = (over: Partial<ReportTaskRow>): ReportTaskRow => ({
  id: String(++seq), title: `Задача ${seq}`, project_id: 'p1', project_name: 'Сайт', assignee_id: 'u1', assignee_name: 'Анна',
  creator_name: 'Борис', priority: 'normal', created_at: at('2026-09-02T09:00:00Z'), closed_at: null, deadline_at: null,
  status: 'В работе', approval_state: null, tags: [], ...over,
});
const input = (tasks: ReportTaskRow[], over: Partial<ReportInput> = {}): ReportInput => ({
  companyName: 'Борис и КО', logoDataUri: null, timezone: MSK, from: '2026-09-01', to: '2026-09-30',
  start, end, prevStart, prevEnd: start, now: at('2026-10-02T09:00:00Z'), generatedBy: 'Борис',
  scope: { projectName: null, personName: null }, tasks, hours: [], tracksTime: false, ...over,
});
const kpi = (r: ReturnType<typeof buildTaskReport>, key: string) => r.kpis.find((k) => k.key === key)!;

describe('Отчёт по задачам за период', () => {
  it('«в срок» — только среди задач со сроком; без срока — отдельно, процент не завышают', () => {
    const r = buildTaskReport(input([
      task({ closed_at: at('2026-09-10T10:00:00Z'), deadline_at: at('2026-09-11T10:00:00Z') }), // в срок
      task({ closed_at: at('2026-09-12T10:00:00Z'), deadline_at: at('2026-09-11T10:00:00Z') }), // на сутки позже
      task({ closed_at: at('2026-09-12T10:00:00Z') }), // без срока
      task({ closed_at: at('2026-09-13T10:00:00Z') }), // без срока
    ]));
    expect(kpi(r, 'completed').value).toBe(4);
    expect(kpi(r, 'ontime').value).toBe(50);
    expect(r.quality).toEqual({ onTime: 1, late: 1, noDeadline: 2 });
    expect(r.completed.find((t) => t.verdict === 'late')?.days).toBe(1);
  });

  it('просрочено и в работе — на конец периода, а не на сегодня', () => {
    const r = buildTaskReport(input([
      // открыта на 1 октября, срок прошёл в сентябре → просрочена на конец периода
      task({ deadline_at: at('2026-09-20T10:00:00Z') }),
      // закрыта 1 октября (уже после периода) → на конец сентября была открыта и просрочена
      task({ deadline_at: at('2026-09-25T10:00:00Z'), closed_at: at('2026-10-01T08:00:00Z') }),
      // срок в октябре → на конец сентября открыта, но не просрочена
      task({ deadline_at: at('2026-10-05T10:00:00Z') }),
      // создана в октябре → в сентябрьский отчёт не входит вовсе
      task({ created_at: at('2026-10-01T10:00:00Z'), deadline_at: at('2026-09-01T10:00:00Z') }),
    ]));
    expect(r.ongoing).toBe(false);
    expect(kpi(r, 'overdue').value).toBe(2);
    expect(kpi(r, 'open').value).toBe(3);
    expect(kpi(r, 'created').value).toBe(3);
    expect(r.overdue.map((t) => t.verdict)).toEqual(['overdue', 'overdue']);
  });

  it('идущий период считает «на конец» по текущему моменту и показывает задачи, ждущие приёмки', () => {
    const r = buildTaskReport(input([
      task({ deadline_at: at('2026-09-29T10:00:00Z'), approval_state: 'pending' }),
      task({ deadline_at: at('2026-10-01T12:00:00Z') }),
    ], { now: at('2026-09-30T09:00:00Z') }));
    expect(r.ongoing).toBe(true);
    expect(kpi(r, 'overdue').value).toBe(1);
    expect(r.review).toHaveLength(1);
    expect(r.soon.map((t) => t.verdict)).toEqual(['soon']); // срок через сутки — под риском
  });

  it('сравнение с прошлым периодом той же длины', () => {
    const r = buildTaskReport(input([
      task({ created_at: at('2026-08-10T10:00:00Z'), closed_at: at('2026-08-12T10:00:00Z') }),
      task({ closed_at: at('2026-09-05T10:00:00Z') }),
      task({ closed_at: at('2026-09-06T10:00:00Z') }),
    ]));
    expect(kpi(r, 'completed')).toMatchObject({ value: 2, prev: 1 });
    expect(r.insights[0]).toContain('на 100% больше');
  });

  it('период и подписи — по-человечески', () => {
    expect(periodLabel('2026-09-01', '2026-09-30')).toBe('Сентябрь 2026');
    expect(periodLabel('2026-09-28', '2026-10-04')).toBe('28 сентября – 4 октября 2026');
    expect(periodLabel('2026-09-07', '2026-09-13')).toBe('7–13 сентября 2026');
  });

  it('HTML отчёта экранирует названия задач и собирается без данных', () => {
    const html = renderTaskReportHtml(buildTaskReport(input([
      task({ title: '<script>alert(1)</script>', closed_at: at('2026-09-10T10:00:00Z') }),
    ])));
    expect(html).not.toContain('<script>alert');
    expect(html).toContain('&lt;script&gt;');
    expect(renderTaskReportHtml(buildTaskReport(input([])))).toContain('задач нет');
  });
});

describe('Кто какой отчёт может собрать', () => {
  const repo = {
    company: async () => ({ name: 'К', timezone: MSK, logo_file_id: null }),
    bounds: async () => ({ start, end }),
    projectName: async () => ({ name: 'Сайт' }),
    userName: async (_t: string, id: string) => ({ full_name: `user ${id}` }),
    tasks: jest.fn(async () => []), hours: jest.fn(async () => []), tracksTime: async () => false,
  };
  const svc = new ReportsService(repo as any, {} as any, {} as any);
  const q = { from: '2026-09-01', to: '2026-09-30' };

  it('сотрудник получает только свой отчёт, даже не указав себя', async () => {
    await svc.build({ userId: '7', tenantId: '1', role: 'member', email: '' }, q);
    expect((repo.tasks.mock.calls.at(-1) as any[])[0]).toMatchObject({ userId: '7' });
    await expect(svc.build({ userId: '7', tenantId: '1', role: 'member', email: '' }, { ...q, userId: '8' })).rejects.toThrow();
  });

  it('руководитель — по всей компании или по любому сотруднику', async () => {
    await svc.build({ userId: '2', tenantId: '1', role: 'manager', email: '' }, q);
    expect((repo.tasks.mock.calls.at(-1) as any[])[0]).toMatchObject({ userId: null });
    await svc.build({ userId: '2', tenantId: '1', role: 'manager', email: '' }, { ...q, userId: '8' });
    expect((repo.tasks.mock.calls.at(-1) as any[])[0]).toMatchObject({ userId: '8' });
  });

  it('период проверяется: перепутанные даты и больше года — отказ', async () => {
    const owner = { userId: '1', tenantId: '1', role: 'owner' as const, email: '' };
    await expect(svc.build(owner, { from: '2026-09-30', to: '2026-09-01' })).rejects.toThrow(/позже/);
    await expect(svc.build(owner, { from: '2024-01-01', to: '2026-01-01' })).rejects.toThrow(/года/);
  });
});
