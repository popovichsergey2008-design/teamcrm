import { inviteList, matchPeople, messageKey, outsiderName, splitBatches } from './import-plan';
import { ImportMessage, ImportPerson, summarize } from './import-types';
import { isSlackFileHost, storableMime } from './migration-import.service';

const person = (ext: string, name: string, email: string | null = null, extra: Partial<ImportPerson> = {}): ImportPerson =>
  ({ ext, name, email, isBot: false, deleted: false, ...extra });
const msg = (ext: string, extra: Partial<ImportMessage> = {}): ImportMessage =>
  ({ ext, at: Number(ext), authorExt: 'U1', authorName: 'А', body: ext, files: [], ...extra });

describe('import-plan', () => {
  const users = [
    { id: '10', email: 'anna@example.com', full_name: 'Анна Петрова' },
    { id: '11', email: 'x@example.com', full_name: 'Сергей Иванов' },
    { id: '12', email: 'y@example.com', full_name: 'Иванов Сергей' },
    { id: '13', email: 'z@example.com', full_name: 'Пётр Сидоров' },
  ];

  it('сопоставляет по почте, по имени — только однозначно, ботов никогда', () => {
    const m = matchPeople([
      person('U1', 'Кто-то', 'ANNA@example.com'),
      person('U2', 'Сергей Иванов'), // два таких в команде — не угадываем
      person('U3', 'Сидоров Петр'), // порядок слов и «ё» не мешают
      person('B1', 'Анна Петрова', null, { isBot: true }),
      person('U4', 'Незнакомец', 'new@example.com'),
    ], users);
    expect([...m.entries()]).toEqual([['U1', '10'], ['U3', '13']]);
  });

  it('приглашает только живых участников выбранных чатов, без повторов', () => {
    const people = [
      person('U1', 'А', 'anna@example.com'),
      person('U4', 'Новый', 'New@Example.com'),
      person('U5', 'Ушёл', 'gone@example.com', { deleted: true }),
      person('U6', 'Не в чатах', 'far@example.com'),
      person('U7', 'Уже позван', 'pending@example.com'),
      person('U8', 'Без почты'),
    ];
    const matched = new Map([['U1', '10']]);
    const involved = new Set(['U1', 'U4', 'U5', 'U7', 'U8']);
    expect(inviteList(people, matched, involved, new Set(['pending@example.com']))).toEqual(['new@example.com']);
  });

  it('пачки: корень ветки и цитата всегда в более ранней пачке, порядок сохранён', () => {
    const list = [msg('1'), msg('2'), msg('3', { threadExt: '2' }), msg('4'), msg('5', { replyToExt: '1' }), msg('6', { threadExt: '99' })];
    const batches = splitBatches(list, 10);
    expect(batches.map((b) => b.map((m) => m.ext))).toEqual([['1', '2'], ['3', '4', '5', '6']]);
    expect(batches.flat().map((m) => m.ext)).toEqual(list.map((m) => m.ext));
  });

  it('10 000 сообщений без веток — 20 запросов по 500', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => msg(String(i + 1)));
    const batches = splitBatches(many);
    expect(batches).toHaveLength(20);
    expect(batches.every((b) => b.length === 500)).toBe(true);
  });

  it('ключ и подпись автора вне команды', () => {
    expect(messageKey('slack:T9', 'C1', '1.2')).toBe('slack:T9:C1:1.2');
    expect(outsiderName('Анна', 'slack')).toBe('Анна (Slack)');
    expect(outsiderName('  Очень   длинное имя '.repeat(10), 'telegram').length).toBeLessThanOrEqual(60);
  });

  it('сводка архива', () => {
    const s = summarize({
      source: 'telegram', sourceKey: 'tg', skippedService: 0, warnings: [],
      people: [person('u1', 'А', 'a@a.ru'), person('u2', 'Б'), person('b', 'Бот', null, { isBot: true })],
      chats: [
        { ext: '1', kind: 'tg_group', title: 'Группа', memberExts: [], messages: [msg('1000', { files: [{ ext: 'f', name: 'a', mime: null, size: null }] }), msg('3000')] },
        { ext: '2', kind: 'tg_personal', title: 'Личка', memberExts: [], messages: [msg('2000')] },
      ],
    });
    expect(s).toMatchObject({ people: 2, peopleWithEmail: 1, messages: 3, files: 1 });
    expect(s.chats[0]).toMatchObject({ selected: true, firstAt: new Date(1000).toISOString(), lastAt: new Date(3000).toISOString() });
    expect(s.chats[1].selected).toBe(false);
  });

  it('файлы Slack качаем только с самого Slack', () => {
    expect(isSlackFileHost('https://files.slack.com/files-pri/x?t=1')).toBe(true);
    expect(isSlackFileHost('http://files.slack.com/x')).toBe(false);
    expect(isSlackFileHost('https://files.slack.com.evil.ru/x')).toBe(false);
    expect(isSlackFileHost('https://169.254.169.254/latest')).toBe(false);
    expect(isSlackFileHost('не ссылка')).toBe(false);
  });

  it('тип файла: известный — как есть, незнакомый — «просто файл»', () => {
    expect(storableMime('image/png', 'a.png')).toBe('image/png');
    expect(storableMime(null, 'отчёт.docx')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(storableMime('application/x-sketch', 'a.sketch')).toBe('application/octet-stream');
  });
});
