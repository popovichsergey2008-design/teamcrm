import { briefLines, followupTemplate, speakable } from './skills-rules';

describe('письмо клиенту и утренний бриф', () => {
  it('письмо без модели: договорённости, кто что делает, подпись', () => {
    const r = followupTemplate({
      meetingTitle: 'Запуск сайта', clientName: 'Банк', contactName: 'Ирина', myName: 'Сергей Попович',
      summary: 'Обсудили сроки запуска.', decisions: ['Запуск 20 октября'],
      tasks: [{ title: 'Прислать макеты', who: 'Анна', deadline: '15.10' }],
    });
    expect(r.subject).toBe('Итоги встречи: Запуск сайта');
    expect(r.body).toContain('Ирина, добрый день!');
    expect(r.body).toContain('— Запуск 20 октября');
    expect(r.body).toContain('— Прислать макеты — Анна, до 15.10');
    expect(r.body.endsWith('С уважением, Сергей Попович')).toBe(true);
  });

  it('бриф: только непустые пункты, не больше семи', () => {
    const lines = briefLines({
      closedYesterday: 5, createdYesterday: 3, overdue: 2, dueToday: 4, hottest: { title: 'Смета', who: 'Глеб' },
      decisionsWaiting: 3, approvalsWaiting: 0, meetingsToday: 2, firstMeeting: { title: 'Планёрка', time: '10:00' },
      prepared: { replies: 0, letters: 1, meetingDrafts: 0 }, overloaded: [],
    });
    expect(lines).toEqual([
      'Вчера закрыто задач: 5, новых: 3.',
      'Горит: срок сегодня — 4, просрочено — 2. Главное — «Смета» (Глеб).',
      'Ждут вашего решения: предложений секретаря — 3.',
      'Встреч сегодня: 2, первая в 10:00 — «Планёрка».',
      'Подготовлено: писем клиентам — 1.',
    ]);
    const empty = briefLines({
      closedYesterday: 0, createdYesterday: 0, overdue: 0, dueToday: 0, hottest: null, decisionsWaiting: 0, approvalsWaiting: 0,
      meetingsToday: 0, firstMeeting: null, prepared: { replies: 0, letters: 0, meetingDrafts: 0 }, overloaded: [],
    });
    expect(empty).toEqual(['Ничего не горит: сроков на сегодня и ждущих решений нет.']);
  });

  it('текст для голоса — без кавычек и тире', () => {
    expect(speakable('Сергей Попович', ['Главное — «Смета».'])).toBe('Доброе утро, Сергей. Главное, Смета.');
  });
});
