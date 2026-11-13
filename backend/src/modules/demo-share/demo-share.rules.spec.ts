import { cleanTask, demoPage, scrub } from './demo-share.rules';

describe('«Отправить коллеге» (#4863)', () => {
  it('без личных данных: почта, телефон, ник, ссылка вырезаются', () => {
    const s = scrub('Катя @katya_m, почта katya@firma.ru, тел. +7 (921) 983-53-11, макет https://figma.com/x до четверга', 500);
    expect(s).not.toMatch(/katya|firma|983|figma/);
    expect(s).toContain('до четверга');
  });
  it('карточка без названия не сохраняется, лишнее обрезается', () => {
    expect(cleanTask({ title: '' })).toBeNull();
    const t = cleanTask({ title: 'Отчёт по заявкам', who: 'Катя', due: 'Чт, 18:00', check: ['a', 'b', '', 'c'], project: 'Маркетинг' })!;
    expect(t.check).toEqual(['a', 'b', 'c']);
    expect(t.priority).toBeNull();
  });
  it('страница закрыта от индексации, с превью и кнопкой на главную', () => {
    const html = demoPage({ code: 'abc23def', message: 'Катя, сделай <b>отчёт</b>', task: cleanTask({ title: 'Отчёт', check: ['Собрать'] })! });
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
    expect(html).toContain('https://qevo.one/demo/abc23def/og.png');
    expect(html).toContain('Попробуйте со своим сообщением');
    expect(html).toContain('&lt;b&gt;отчёт&lt;/b&gt;');
  });
});
