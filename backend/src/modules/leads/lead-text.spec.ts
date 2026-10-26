import { leadText } from './leads.service';

describe('заявка с сайта: дежурному — выбранный сценарий (#4648)', () => {
  const now = new Date('2026-10-26T09:00:00Z'); // 12:00 МСК
  const contact = 'Telegram: @lee_unicorn';

  it('видео: заголовок и что сделать — про ролики, без срока плана', () => {
    const t = leadText({ source: 'quiz', from: 'bitrix24', team: '6-15', want: 'video' }, contact, now);
    expect(t.split('\n')[0]).toBe('Заявка с сайта: прислать видео работы приложения');
    expect(t).toContain('отправьте короткие ролики QEVO');
    expect(t).not.toContain('план переезда');
    expect(t).toContain(contact);
  });

  it('план: заголовок, сервис и срок «через 24 часа» по Москве', () => {
    const t = leadText({ source: 'exit', from: 'yougile', team: '1-5', want: 'plan' }, contact, now);
    expect(t.split('\n')[0]).toBe('Заявка с сайта: план переезда (окно при уходе)');
    expect(t).toContain('план переезда из «YouGile»');
    expect(t).toContain('до 27.10, 12:00 МСК');
    expect(t).not.toContain('ролики');
  });

  it('старая страница без выбора — как раньше, план переезда', () => {
    expect(leadText({ source: 'quiz' }, contact, now).split('\n')[0]).toBe('Заявка с сайта: план переезда');
  });

  it('вопрос «за 30 секунд» не путается со сценариями', () => {
    const t = leadText({ source: 'support', message: 'Есть ли API?' }, contact, now);
    expect(t).toContain('ответьте сейчас');
    expect(t).toContain('Вопрос: Есть ли API?');
  });
});
