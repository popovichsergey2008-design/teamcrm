import {
  centerKey, mentionedUsers, TASK_EVENT_KEY, TaskEventKind, taskEventPhrase, taskEventText, taskRecipients, TaskPeople,
} from './center-rules';

/**
 * Центр уведомлений (#4655): кому событие по задаче и какими словами.
 *
 * Главные обещания: автор о своём действии не узнаёт, наблюдатель и соисполнитель
 * не теряются, вопрос к постановщику не будит исполнителя, а системное событие
 * (срок подошёл) доходит до всех, кому положено.
 */
describe('центр уведомлений: адресаты события по задаче', () => {
  // исполнитель 1, постановщик 2, соисполнитель 3, наблюдатели 4 и 5
  const people: TaskPeople = { assigneeId: '1', creatorId: '2', coAssignees: ['3'], watchers: ['4', '5'] };
  const ids = (kind: TaskEventKind, actor: string | null, opts = {}) =>
    taskRecipients(kind, people, actor, opts).map((r) => r.userId);

  it('автор действия себе не пишет — ни в одном событии', () => {
    const kinds = Object.keys(TASK_EVENT_KEY) as TaskEventKind[];
    for (const kind of kinds) {
      for (const actor of ['1', '2', '3', '4']) {
        expect(ids(kind, actor, { targets: [actor], previous: actor })).not.toContain(actor);
      }
    }
  });

  it('статус, срок, приоритет — всем участникам, и каждому один раз', () => {
    expect(ids('status', '2').sort()).toEqual(['1', '3', '4', '5']);
    expect(ids('deadline', '1').sort()).toEqual(['2', '3', '4', '5']);
    // исполнитель он же наблюдатель — одна строка, а не две
    const doubled: TaskPeople = { ...people, watchers: ['1', '4'] };
    expect(taskRecipients('priority', doubled, '2').map((r) => r.userId)).toEqual(['1', '3', '4']);
  });

  it('новая задача — исполнителю и постановщику; соисполнителей зовёт «добавил вас»', () => {
    expect(ids('created', '2')).toEqual(['1']);
    // руководитель поставил задачу от имени другого постановщика — тот тоже узнаёт
    expect(taskRecipients('created', people, '9')).toEqual([
      { userId: '1', role: 'assignee' }, { userId: '2', role: 'creator' },
    ]);
    expect(ids('participant', '2', { targets: ['4'] })).toEqual(['4']);
  });

  it('сдал на проверку, просит перенос, блокер — постановщику и наблюдателям, не исполнителям', () => {
    for (const kind of ['approval', 'shift_asked', 'blocked'] as TaskEventKind[]) {
      expect(ids(kind, '1').sort()).toEqual(['2', '4', '5']);
    }
  });

  it('вернули на доработку — исполнителю и соисполнителям', () => {
    expect(ids('returned', '2').sort()).toEqual(['1', '3']);
  });

  it('смена исполнителя: новому — «назначил вас», прежнему — «передал», остальным — «сменил»', () => {
    const r = taskRecipients('assignee', { ...people, assigneeId: '7' }, '2', { targets: ['7'], previous: '1' });
    expect(r[0]).toEqual({ userId: '7', role: 'target' });
    expect(r[1]).toEqual({ userId: '1', role: 'previous' });
    expect(r.map((x) => x.userId)).not.toContain('2');
    expect(taskEventPhrase('assignee', 'target')).toBe('назначил вас исполнителем задачи');
    expect(taskEventPhrase('assignee', 'previous')).toBe('передал другому исполнителю задачу');
    expect(taskEventPhrase('assignee', 'watcher')).toBe('сменил исполнителя задачи');
    // род по имени автора: угадали женский — «добавила», не угадали — мужской
    expect(taskEventPhrase('participant', 'watcher', { participantRole: 'watcher' }, 'Кривонос Валентина Игоревна')).toBe('добавила вас наблюдателем в задачу');
    expect(taskEventPhrase('shift_asked', 'creator', {}, 'Анна Лебедева')).toBe('просит перенести срок задачи');
    expect(taskEventPhrase('comment', 'assignee', {}, 'Глеб Смирнов')).toBe('оставил комментарий к задаче');
  });

  it('комментарий: упомянутым — отдельно, остальным — «оставил комментарий»', () => {
    expect(ids('mention', '1', { targets: ['4', '8'] })).toEqual(['4', '8']);
    expect(ids('comment', '1', { except: ['4'] }).sort()).toEqual(['2', '3', '5']);
  });

  it('срок подошёл — исполнителям; без исполнителя — постановщику; просрочка — и постановщику', () => {
    expect(ids('deadline_soon', null).sort()).toEqual(['1', '3']);
    const nobody: TaskPeople = { assigneeId: null, creatorId: '2', coAssignees: [], watchers: ['4'] };
    expect(taskRecipients('deadline_soon', nobody, null).map((r) => r.userId)).toEqual(['2']);
    expect(ids('overdue', null).sort()).toEqual(['1', '2', '3']);
  });
});

describe('центр уведомлений: слова', () => {
  it('строка для телефона: кто, что и какая задача', () => {
    const t = taskEventText('participant', 'target', 'Ольга Ким', 'Обновить прайс', { participantRole: 'watcher' });
    expect(t.title).toBe('Ольга Ким добавила вас наблюдателем в задачу: Обновить прайс');
    expect(taskEventText('comment', 'assignee', 'Глеб', 'Прайс', { comment: 'Посмотри  \n цены' }).body).toBe('Посмотри цены');
  });

  it('у системного события автора нет — фраза начинает строку сама', () => {
    expect(taskEventText('overdue', 'assignee', null, 'Прайс').title).toBe('Просрочена задача: Прайс');
  });

  it('срок снят и срок изменён — разные слова', () => {
    expect(taskEventPhrase('deadline', 'assignee', { deadline: null })).toBe('снял срок задачи');
    expect(taskEventPhrase('deadline', 'assignee', { deadline: '2026-10-24T18:00:00Z' })).toBe('изменил срок задачи');
  });

  it('ключ строки совпадает с ключом письма — письмо пристёгивается, а не дублирует', () => {
    expect(centerKey('task.created', '12', '7', 'new')).toBe('task.created:12:7:new');
  });
});

describe('центр уведомлений: упоминания в обсуждении задачи', () => {
  const users = [
    { id: '1', full_name: 'Иван Петров' },
    { id: '2', full_name: 'Иван' },
    { id: '3', full_name: 'Ольга Ким' },
  ];

  it('«@Имя Фамилия» находит человека, длинное имя не съедается коротким', () => {
    expect(mentionedUsers('@Иван Петров, глянь', users)).toEqual(['1']);
    expect(mentionedUsers('@иван и @Ольга Ким!', users).sort()).toEqual(['2', '3']);
  });

  it('без «@» и с продолжением слова — не упоминание', () => {
    expect(mentionedUsers('Иван Петров, глянь', users)).toEqual([]);
    expect(mentionedUsers('@Ивановский', users)).toEqual([]);
    expect(mentionedUsers('почта ivan@mail.ru', users)).toEqual([]);
  });
});
