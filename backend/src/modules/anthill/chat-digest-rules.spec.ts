import { classify, digestText, isQuestion, isUrgent, unansweredText } from './chat-digest-rules';

const msg = (o: Partial<Parameters<typeof classify>[0][number]>) => ({
  id: '1', chatId: 'c1', chatKind: 'group', chatTitle: 'Проект', author: 'Глеб', body: 'ок', createdAt: new Date(), mentionsMe: false, ...o,
});

describe('chat-digest-rules', () => {
  it('срочное и вопросы узнаются по словам', () => {
    expect(isUrgent('Срочно нужен доступ')).toBe(true);
    expect(isUrgent('сайт упал')).toBe(true);
    expect(isUrgent('упаковали посылку')).toBe(false);
    expect(isQuestion('когда будет смета')).toBe(true);
    expect(isQuestion('Готово?')).toBe(true);
    expect(isQuestion('Готово, отправил')).toBe(false);
  });

  it('делит на три кучки: критично, ждут ответа, к сведению', () => {
    const d = classify([
      msg({ id: '1', body: 'Прод упал, срочно', chatKind: 'group' }),
      msg({ id: '2', body: 'Когда созвон?', chatKind: 'dm', chatId: 'dm1' }),
      msg({ id: '3', body: '@Сергей глянь макет', mentionsMe: true }),
      msg({ id: '4', body: 'обновил ветку', chatId: 'c2' }),
      msg({ id: '5', body: 'ок', chatId: 'c2' }),
      msg({ id: '6', body: 'спасибо', chatKind: 'dm', chatId: 'dm2' }),
    ]);
    expect(d.critical.map((m) => m.id)).toEqual(['1']);
    expect(d.needReply.map((m) => m.id)).toEqual(['2', '3']);
    expect(d.fyi).toEqual({ chats: 2, messages: 3 });
    const text = digestText(d)!;
    expect(text).toContain('Критично (1):');
    expect(text).toContain('Глеб в личке: «Когда созвон?»');
    expect(text).toContain('К сведению: 3 непрочитанных в 2 чатах');
  });

  it('пусто — сводки нет; неотвеченные — по человеку', () => {
    expect(digestText(classify([]))).toBeNull();
    expect(unansweredText([])).toBeNull();
    expect(unansweredText([{ chatId: '1', chatKind: 'dm', chatTitle: null, to: 'Глеб', body: 'Когда будет смета?', days: 3 }]))
      .toBe('— Глеб (3 дн.): «Когда будет смета?»');
  });
});
