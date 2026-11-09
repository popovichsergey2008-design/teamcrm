import { chunkDoc } from './doc-chunks';

describe('chunkDoc — нарезка документа по разделам', () => {
  const doc = [
    'Справочник QEVO · Входящие',
    '# Входящие',
    '',
    'Вступление о разделе.',
    '',
    '## Как отложить строку',
    '',
    '1. Выберите строку.',
    '2. Нажмите «Отложить».',
    '',
    '## Горячие клавиши',
    '',
    'J / K — следующая строка.',
  ].join('\n');

  it('каждый кусок начинается с пути «документ › раздел», заголовок # не дублируется', () => {
    const out = chunkDoc(doc, 1200, 150);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe('Справочник QEVO · Входящие\nВступление о разделе.');
    expect(out[1].startsWith('Справочник QEVO · Входящие › Как отложить строку\n## Как отложить строку')).toBe(true);
    expect(out[1]).toContain('2. Нажмите «Отложить».');
    expect(out[2]).toContain('› Горячие клавиши');
  });

  it('длинный раздел делится по абзацам, путь — в каждом куске, ни один не длиннее размера', () => {
    const para = (n: number) => `Абзац ${n}. ` + 'слово '.repeat(40);
    const long = ['Регламент', '## Большой раздел', ...Array.from({ length: 12 }, (_, i) => `\n${para(i)}`)].join('\n');
    const out = chunkDoc(long, 600, 100);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) {
      expect(c.startsWith('Регламент › Большой раздел\n')).toBe(true);
      expect(c.length).toBeLessThanOrEqual(600);
    }
    expect(out.join('\n')).toContain('Абзац 11.');
  });

  it('абзац длиннее куска режется по символам с нахлёстом; пустой текст — без кусков', () => {
    const out = chunkDoc('Док\n' + 'я'.repeat(1000), 400, 50);
    expect(out.length).toBeGreaterThan(2);
    for (const c of out) expect(c.length).toBeLessThanOrEqual(400);
    expect(chunkDoc('  ', 400, 50)).toEqual([]);
  });
});
