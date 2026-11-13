import {
  canRevokeLink, clientStatus, guestCanSee, guestFeed, guestName, linkDays, linkRefusal, mentionedTask, modelReplyOk,
  RawMessage, ruleReply, sessionRefusal, staffRefusal, statusSummary, toGuestMessage, toGuestTasks,
} from './client-chat-rules';

const msg = (o: Partial<RawMessage>): RawMessage => ({
  id: '1', chat_id: '10', author_id: '5', author_name: 'Анна', body: 'Привет', created_at: '2026-11-13T10:00:00Z', ...o,
});

describe('что видно гостю чата с клиентом', () => {
  it('обычное сообщение этого чата — видно', () => {
    expect(guestCanSee(msg({}), '10')).toBe(true);
  });
  it('сообщение другого (внутреннего) чата — никогда', () => {
    expect(guestCanSee(msg({ chat_id: '11' }), '10')).toBe(false);
  });
  it('удалённое, ветка без выноса в ленту, ИИ, карточки — не видны', () => {
    expect(guestCanSee(msg({ deleted_at: '2026-11-13T11:00:00Z' }), '10')).toBe(false);
    expect(guestCanSee(msg({ thread_root_id: '3' }), '10')).toBe(false);
    expect(guestCanSee(msg({ thread_root_id: '3', also_in_channel: true }), '10')).toBe(true);
    expect(guestCanSee(msg({ is_ai: true }), '10')).toBe(false);
    expect(guestCanSee(msg({ meeting_id: '7' }), '10')).toBe(false);
    expect(guestCanSee(msg({ proposal_id: '8' }), '10')).toBe(false);
  });
  it('пересланное из другого чата — это внутренняя переписка, не видно', () => {
    expect(guestCanSee(msg({ forwarded_chat_id: '99' }), '10')).toBe(false);
    expect(guestCanSee(msg({ forwarded_chat_id: '10' }), '10')).toBe(true);
  });
  it('лента: фильтр и проекция без внутренних полей, секреты скрыты', () => {
    const feed = guestFeed([
      msg({ id: '1', body: 'пароль: Sup3rSecret!42' }),
      msg({ id: '2', chat_id: '11', body: 'клиент опять всё переиграл' }),
      msg({ id: '3', is_ai: true, body: 'Отвечает Борис' }),
      msg({ id: '4', author_id: null, author_name: null, guest_name: 'Иван', body: 'Когда макет?' }),
    ], '10', 'иван');
    expect(feed.map((m) => m.id)).toEqual(['1', '4']);
    expect(feed[0].body).not.toContain('Sup3rSecret');
    expect(Object.keys(feed[0]).sort()).toEqual(['attachment', 'author_name', 'body', 'created_at', 'edited', 'guest_name', 'id', 'mine']);
    expect(feed[1]).toMatchObject({ mine: true, guest_name: 'Иван', author_name: null });
    expect(feed[0]).toMatchObject({ mine: false, author_name: 'Анна' });
  });
  it('вложение — только имя, без номера файла', () => {
    const m = toGuestMessage(msg({ file_name: 'ТЗ.pdf' }), null);
    expect(m.attachment).toBe('ТЗ.pdf');
    expect(JSON.stringify(m)).not.toContain('file_id');
  });
});

describe('сессия гостя', () => {
  const ok = {
    found: true, revokedAt: null, expiresAt: '2030-01-01T00:00:00Z', linkRevokedAt: null, linkExpiresAt: '2030-01-01T00:00:00Z',
    chatExternal: true, guestRemoved: false,
  };
  const now = Date.parse('2026-11-13T12:00:00Z');
  it('живая сессия — пускаем', () => { expect(sessionRefusal(ok, now)).toBeNull(); });
  it('нет сессии, отозвана ссылка или сессия — нет', () => {
    expect(sessionRefusal({ ...ok, found: false }, now)).toBe('unknown');
    expect(sessionRefusal({ ...ok, linkRevokedAt: '2026-11-13T11:00:00Z' }, now)).toBe('revoked');
    expect(sessionRefusal({ ...ok, revokedAt: '2026-11-13T11:00:00Z' }, now)).toBe('revoked');
  });
  it('срок вышел у сессии или ссылки — нет', () => {
    expect(sessionRefusal({ ...ok, expiresAt: '2026-11-13T11:00:00Z' }, now)).toBe('expired');
    expect(sessionRefusal({ ...ok, linkExpiresAt: '2026-11-13T11:00:00Z' }, now)).toBe('expired');
  });
  it('чат перестал быть внешним или гостя убрали — нет', () => {
    expect(sessionRefusal({ ...ok, chatExternal: false }, now)).toBe('chat-closed');
    expect(sessionRefusal({ ...ok, guestRemoved: true }, now)).toBe('removed');
  });
  it('ссылка для входа: только живая и только на внешний чат', () => {
    expect(linkRefusal(null, true, now)).toBe('unknown');
    expect(linkRefusal({ revoked_at: '2026-11-01', expires_at: '2030-01-01' }, true, now)).toBe('revoked');
    expect(linkRefusal({ revoked_at: null, expires_at: '2026-11-01' }, true, now)).toBe('expired');
    expect(linkRefusal({ revoked_at: null, expires_at: '2030-01-01' }, false, now)).toBe('chat-closed');
    expect(linkRefusal({ revoked_at: null, expires_at: '2030-01-01' }, true, now)).toBeNull();
  });
  it('имя: 2–60 знаков, без управляющих символов', () => {
    expect(guestName(' Иван\u0000 Петров ')).toBe('Иван Петров');
    expect(guestName('И')).toBeNull();
    expect(guestName('x'.repeat(100))!.length).toBe(60);
  });
});

describe('права сотрудника', () => {
  it('клиент с учёткой, не участник, не внешний чат — отказ', () => {
    expect(staffRefusal({ role: 'client', chatExists: true, isExternal: true, isMember: true })).toBeTruthy();
    expect(staffRefusal({ role: 'member', chatExists: false, isExternal: false, isMember: false })).toBe('Чат не найден');
    expect(staffRefusal({ role: 'member', chatExists: true, isExternal: true, isMember: false })).toBeTruthy();
    expect(staffRefusal({ role: 'owner', chatExists: true, isExternal: false, isMember: true })).toBeTruthy();
    expect(staffRefusal({ role: 'member', chatExists: true, isExternal: true, isMember: true })).toBeNull();
  });
  it('отозвать: автор, админ чата, руководство', () => {
    expect(canRevokeLink({ userId: '1', role: 'member', linkAuthor: '1', chatRole: 'member' })).toBe(true);
    expect(canRevokeLink({ userId: '2', role: 'member', linkAuthor: '1', chatRole: 'member' })).toBe(false);
    expect(canRevokeLink({ userId: '2', role: 'member', linkAuthor: '1', chatRole: 'admin' })).toBe(true);
    expect(canRevokeLink({ userId: '2', role: 'manager', linkAuthor: '1', chatRole: null })).toBe(true);
  });
  it('срок ссылки: по умолчанию 90 дней, не больше года', () => {
    expect(linkDays(undefined)).toBe(90);
    expect(linkDays(1000)).toBe(365);
    expect(linkDays(7)).toBe(7);
  });
});

describe('статусы задач и подсказка ответа', () => {
  const now = Date.parse('2026-11-13T12:00:00Z');
  const rows = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `d${i}`, title: `Готовое ${i}`, stage_type: 'done', closed_at: null, deadline_at: null })),
    ...Array.from({ length: 11 }, (_, i) => ({ id: `w${i}`, title: `Раздел ${i}`, stage_type: 'work', closed_at: null, deadline_at: '2026-11-18T09:00:00Z' })),
    { id: 'm', title: 'Макет главной страницы', stage_type: 'review', closed_at: null, deadline_at: '2026-11-20T09:00:00Z' },
  ];
  it('статус по типу этапа, а не по названию колонки', () => {
    expect(clientStatus({ stage_type: 'work', closed_at: '2026-11-01' })).toBe('done');
    expect(clientStatus({ stage_type: 'testing', closed_at: null })).toBe('review');
    expect(clientStatus({ stage_type: 'waiting_external', closed_at: null })).toBe('waiting_you');
    expect(clientStatus({ stage_type: null, closed_at: null })).toBe('work');
  });
  it('гостю — без номеров и удалённых', () => {
    const t = toGuestTasks([...rows, { id: 'x', title: 'В корзине', stage_type: 'work', closed_at: null, deadline_at: null, deleted_at: '2026-11-10' }], now);
    expect(t).toHaveLength(17);
    expect(JSON.stringify(t)).not.toContain('"id"');
  });
  it('«5 из 17 задач готово, срок 20.11»', () => {
    expect(statusSummary(toGuestTasks(rows, now)).text).toBe('5 из 17 задач готово, срок 20.11.');
    expect(statusSummary([]).text).toMatch(/пока нет/);
  });
  it('подсказка называет задачу из вопроса клиента и общую сводку', () => {
    const tasks = toGuestTasks(rows, now);
    expect(mentionedTask('Как там макет главной?', tasks)?.title).toBe('Макет главной страницы');
    const r = ruleReply('Как там макет главной?', tasks);
    expect(r).toContain('«Макет главной страницы» — на проверке, срок 20.11');
    expect(r).toContain('5 из 17 задач готово, срок 20.11');
  });
  it('ответ модели принимаем, только если цифры совпали', () => {
    const sum = statusSummary(toGuestTasks(rows, now));
    expect(modelReplyOk('Готово 5 из 17 задач, срок 20.11.', sum)).toBe(true);
    expect(modelReplyOk('Почти всё готово, скоро закончим.', sum)).toBe(false);
  });
});
