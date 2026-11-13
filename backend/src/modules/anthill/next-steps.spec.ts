import JSZip from 'jszip';
import { answerRows, nextSteps, slotsFrom } from './next-steps';
import { xlsxFrom } from './xlsx';

describe('кнопки следующего шага (#4893, п. 4)', () => {
  it('слоты — чипы времени, клик ставит встречу через карточку', () => {
    const finding = '[find_slots]\nСвободно для: вы и Глеб (60 мин):\n1. ср, 19 нояб, 11:00–12:00 — ISO 2026-11-19T08:00:00.000Z\n2. чт — ISO 2026-11-20T11:00:00.000Z';
    expect(slotsFrom(finding)).toHaveLength(2);
    const b = nextSteps({ question: 'найди час с Глебом', used: [{ tool: 'find_slots', params: { people: 'Глеб', duration: 60 } }], findings: [finding], tz: 'Europe/Moscow' });
    expect(b).toHaveLength(2);
    expect(b[0].kind).toBe('prompt');
    expect(b[0].label).toContain('11:00');
    expect((b[0] as { prompt: string }).prompt).toContain('участники: Глеб');
  });
  it('список задач — «Создать», «Перенести», «Делегировать»', () => {
    const b = nextSteps({ question: 'мои задачи на неделю', used: [{ tool: 'search_tasks', params: {} }], findings: [], tz: null });
    expect(b.map((x) => x.label)).toEqual(expect.arrayContaining(['Создать', 'Перенести', 'Делегировать']));
  });
  it('сводка — задачи по рискам и Excel; регулярность предлагается один раз', () => {
    const b = nextSteps({ question: 'сводка по проектам', used: [{ tool: 'team_pulse', params: {} }], findings: [], tz: null });
    expect(b.map((x) => x.kind)).toEqual(['prompt', 'download', 'schedule']);
    const again = nextSteps({ question: 'каждый день присылай сводку', used: [{ tool: 'team_pulse', params: {} }], findings: [], tz: null });
    expect(again.some((x) => x.kind === 'schedule')).toBe(false);
  });
  it('почты нет — кнопка подключения с исходной просьбой (п. 2)', () => {
    const b = nextSteps({ question: 'что важного в почте', used: [{ tool: 'mail_inbox', params: {} }], findings: ['[mail_inbox] Почта не подключена. Скажи…'], tz: null });
    expect(b).toEqual([{ kind: 'connect_mail', label: 'Подключить почту', resume: 'что важного в почте' }]);
  });
  it('без инструментов — всё равно кнопка, не вопрос', () => {
    expect(nextSteps({ question: 'привет', used: [], findings: [], tz: null })).toHaveLength(1);
  });
  it('ответ → строки и настоящий .xlsx', async () => {
    const rows = answerRows('**Итоги**\n1. Готово: 5 задач [1]\n- Риски: срок #4800\n| A | B |\n|---|---|\n| x | y |');
    expect(rows).toEqual([['Итоги'], ['Готово', '5 задач'], ['Риски', 'срок 4800'], ['A', 'B'], ['x', 'y']]);
    const zip = await JSZip.loadAsync(await xlsxFrom(rows));
    expect(await zip.file('xl/worksheets/sheet1.xml')!.async('string')).toContain('5 задач');
  });
});
