import { cleanDraft, LastMessage, needsReply } from './smart-reply-rules';

const now = new Date('2026-10-11T12:00:00Z');
const msg = (id: string, authorId: string, body: string, extra: Partial<LastMessage> = {}): LastMessage => ({
  id, authorId, body, createdAt: new Date(now.getTime() - 10 * 60_000), isAi: false, mentionsMe: false, replyToMine: false, ...extra,
});

describe('готовый ответ: нужен ли', () => {
  it('личка с вопросом — нужен; моё последнее — нет', () => {
    expect(needsReply({ me: '1', chatKind: 'dm', members: 2, now, messages: [msg('1', '2', 'Когда будет смета?')] }))
      .toEqual({ needed: true, reason: 'dm_question', lastId: '1' });
    expect(needsReply({ me: '1', chatKind: 'dm', members: 2, now, messages: [msg('1', '2', 'Когда?'), msg('2', '1', 'Завтра')] }).needed).toBe(false);
  });

  it('просьба в личке, упоминание и ответ на моё — нужен; болтовня в большой группе — нет', () => {
    expect(needsReply({ me: '1', chatKind: 'dm', members: 2, now, messages: [msg('1', '2', 'скинь договор плиз')] }).reason).toBe('dm_request');
    expect(needsReply({ me: '1', chatKind: 'group', members: 8, now, messages: [msg('1', '2', 'Сергей, глянь', { mentionsMe: true })] }).reason).toBe('mention');
    expect(needsReply({ me: '1', chatKind: 'group', members: 8, now, messages: [msg('1', '2', 'ок', { replyToMine: true })] }).reason).toBe('reply_to_me');
    expect(needsReply({ me: '1', chatKind: 'group', members: 8, now, messages: [msg('1', '2', 'кто идёт обедать?')] }).needed).toBe(false);
    expect(needsReply({ me: '1', chatKind: 'group', members: 3, now, messages: [msg('1', '2', 'кто возьмёт задачу?')] }).reason).toBe('small_group_question');
  });

  it('старое и сообщения ИИ — не считаются', () => {
    const old = msg('1', '2', 'Когда?', { createdAt: new Date(now.getTime() - 4 * 86400_000) });
    expect(needsReply({ me: '1', chatKind: 'dm', members: 2, now, messages: [old] }).needed).toBe(false);
    expect(needsReply({ me: '1', chatKind: 'dm', members: 2, now, messages: [msg('1', '2', 'Готово?', { isAi: true })] }).needed).toBe(false);
  });

  it('черновик чистится', () => {
    expect(cleanDraft('Ответ: «Да, пришлю до пятницы»')).toBe('Да, пришлю до пятницы');
    const long = `${'Предложение номер раз. '.repeat(40)}`;
    expect(cleanDraft(long, 100).endsWith('.')).toBe(true);
  });
});
