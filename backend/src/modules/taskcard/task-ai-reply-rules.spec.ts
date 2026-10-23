import { addressedTo, cleanReply, pickReplyTarget, ReplyMessage, thanksText } from './task-ai-reply-rules';

const ME = { id: '1', name: 'Борис Честный' };
let seq = 0;
const msg = (authorId: string | null, body: string, extra: Partial<ReplyMessage> = {}): ReplyMessage => ({
  id: String(++seq), authorId, authorName: authorId === '1' ? ME.name : authorId === '2' ? 'Никита Адаменко' : 'Глеб Петров',
  body, ...extra,
});

describe('pickReplyTarget — на что отвечать', () => {
  it('обращение ко мне важнее свежего вопроса другому', () => {
    const asked = msg('2', '@Борис Честный, глянешь вёрстку');
    const q = msg('3', 'А кто деплоит?');
    expect(pickReplyTarget([asked, q], ME)).toEqual({ message: asked, reason: 'addressed' });
  });

  it('упоминание по имени и ответ на моё сообщение — тоже ко мне', () => {
    expect(addressedTo(msg('2', 'ок, @борис, принято'), ME)).toBe(true);
    expect(addressedTo(msg('2', 'принято', { replyToAuthorId: '1' }), ME)).toBe(true);
    expect(addressedTo(msg('2', 'принято'), ME)).toBe(false);
  });

  it('без обращения — последний вопрос, без вопроса — последнее чужое', () => {
    const q = msg('2', 'Получится до конца дня?');
    const plain = msg('3', 'Залил на тест');
    expect(pickReplyTarget([q, plain], ME)).toEqual({ message: q, reason: 'question' });
    const a = msg('2', 'Сделал');
    expect(pickReplyTarget([a, plain], ME)).toEqual({ message: plain, reason: 'last' });
  });

  it('сказанное до моего последнего сообщения уже отвечено', () => {
    const old = msg('2', 'Когда будет готово?');
    const mine = msg('1', 'Завтра');
    const fresh = msg('3', 'Хорошо');
    expect(pickReplyTarget([old, mine, fresh], ME)?.message).toBe(fresh);
  });

  it('после меня никто не писал — берём всю ленту; ИИ и служебные не в счёт', () => {
    const q = msg('2', 'Когда будет готово?');
    const mine = msg('1', 'Посмотрю');
    const bot = msg('1', 'Ответ ИИ?', { isAi: true });
    const sys = msg(null, 'Задача перенесена?', { isSystem: true });
    expect(pickReplyTarget([q, mine, bot, sys], ME)).toEqual({ message: q, reason: 'question' });
  });

  it('только мои сообщения — отвечать не на что', () => {
    expect(pickReplyTarget([msg('1', 'Начал'), msg('1', 'Готово?')], ME)).toBeNull();
    expect(pickReplyTarget([], ME)).toBeNull();
  });
});

describe('thanksText — «Спасибо» правилами', () => {
  it('с упоминанием адресата и разными вариантами по кругу', () => {
    expect(thanksText('Никита Адаменко')).toBe('@Никита Адаменко, спасибо!');
    expect(thanksText('Никита Адаменко', 1)).toBe('@Никита Адаменко, спасибо, принял.');
    expect(thanksText('Никита Адаменко', 5)).toBe(thanksText('Никита Адаменко', 0));
  });
  it('без адресата — с заглавной буквы', () => {
    expect(thanksText(null)).toBe('Спасибо!');
  });
});

describe('cleanReply', () => {
  it('убирает «Ответ:» и кавычки', () => {
    expect(cleanReply('Ответ: «@Никита Адаменко, да, успею»', 'Никита Адаменко')).toBe('@Никита Адаменко, да, успею');
  });
  it('дописывает упоминание, если модель его забыла', () => {
    expect(cleanReply('Да, успею до вечера.', 'Никита Адаменко')).toBe('@Никита Адаменко, да, успею до вечера.');
  });
  it('без адресата текст не трогает', () => {
    expect(cleanReply('Сделано: вёрстка. Дальше: тесты.', null)).toBe('Сделано: вёрстка. Дальше: тесты.');
  });
});
