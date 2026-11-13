import JSZip from 'jszip';
import { openArchive } from './archive';
import { readSlackExport, slackRoot, slackText, slackTs, slackUrlHasToken } from './slack-parse';

/** Маленький, но настоящий по форме экспорт Slack. */
async function fixture(prefix = ''): Promise<Buffer> {
  const zip = new JSZip();
  const put = (path: string, data: unknown) => zip.file(`${prefix}${path}`, JSON.stringify(data));
  put('users.json', [
    { id: 'U1', team_id: 'T9', name: 'anna', real_name: 'Анна Петрова', profile: { email: 'Anna@Example.com', real_name: 'Анна Петрова' } },
    { id: 'U2', team_id: 'T9', name: 'boris', profile: { email: 'boris@example.com', real_name: 'Борис' } },
    { id: 'B1', team_id: 'T9', name: 'jira', is_bot: true, profile: {} },
  ]);
  put('channels.json', [{ id: 'C1', name: 'general', members: ['U1', 'U2'], purpose: { value: 'Общий канал' } }]);
  put('groups.json', [{ id: 'G1', name: 'secret', members: ['U1'] }]);
  put('dms.json', [{ id: 'D1', members: ['U1', 'U2'] }]);
  // дни нарочно не по порядку внутри файла — разборщик сортирует сам
  put('general/2024-01-02.json', [
    { type: 'message', user: 'U2', text: 'Ответ в ветке', ts: '1704153600.000300', thread_ts: '1704067200.000100' },
    { type: 'message', user: 'U1', text: 'Второй день <@U2>', ts: '1704153500.000200' },
  ]);
  put('general/2024-01-01.json', [
    { type: 'message', subtype: 'channel_join', user: 'U2', text: '<@U2> has joined', ts: '1704067100.000000' },
    {
      type: 'message', user: 'U1', text: 'Привет &amp; добро пожаловать <https://qevo.one|сайт> в <#C1>', ts: '1704067200.000100',
      thread_ts: '1704067200.000100',
      files: [
        { id: 'F1', name: 'plan.pdf', mimetype: 'application/pdf', size: 100, url_private_download: 'https://files.slack.com/files-pri/T9-F1/download/plan.pdf?t=xoxe-123' },
        { id: 'F2', name: 'old.png', mode: 'hidden_by_limit' },
        { id: 'F3', name: 'notoken.png', url_private_download: 'https://files.slack.com/files-pri/T9-F3/notoken.png' },
      ],
    },
    { type: 'message', subtype: 'bot_message', bot_id: 'B1', username: 'Jira', text: 'PRJ-1 создана', ts: '1704067300.000000' },
  ]);
  put('secret/2024-01-01.json', [{ type: 'message', user: 'U1', text: 'тайна', ts: '1704067200.000500' }]);
  put('D1/2024-01-01.json', [{ type: 'message', user: 'U2', text: 'лично', ts: '1704067200.000900' }]);
  return zip.generateAsync({ type: 'nodebuffer' });
}

describe('slack-parse', () => {
  it('разбирает архив: люди, каналы, лички, порядок и служебные строки', async () => {
    const bundle = await readSlackExport(await JSZip.loadAsync(await fixture()));
    expect(bundle.source).toBe('slack');
    expect(bundle.sourceKey).toBe('slack:T9');
    expect(bundle.people.find((p) => p.ext === 'U1')).toMatchObject({ email: 'anna@example.com', name: 'Анна Петрова', isBot: false });
    expect(bundle.people.find((p) => p.ext === 'B1')?.isBot).toBe(true);

    const general = bundle.chats.find((c) => c.ext === 'C1')!;
    expect(general).toMatchObject({ kind: 'channel', title: 'general', description: 'Общий канал', memberExts: ['U1', 'U2'] });
    // служебная строка о входе в канал не переносится
    expect(bundle.skippedService).toBe(1);
    // хронология, а не порядок файлов и строк в них
    expect(general.messages.map((m) => m.ext)).toEqual([
      '1704067200.000100', '1704067300.000000', '1704153500.000200', '1704153600.000300',
    ]);
    const [first, bot, , reply] = general.messages;
    expect(first.body).toBe('Привет & добро пожаловать сайт (https://qevo.one) в #general');
    expect(first.at).toBe(1704067200000);
    expect(first.threadExt).toBeNull(); // корень ветки — не ответ
    expect(reply.threadExt).toBe('1704067200.000100');
    expect(bot).toMatchObject({ authorExt: 'bot:B1', authorName: 'Jira' });
    expect(general.messages[2].body).toBe('Второй день @Борис');

    // файлы: с токеном — качаем; скрытый тарифом и без токена — сразу в «не удалось»
    expect(first.files[0]).toMatchObject({ ext: 'F1', name: 'plan.pdf' });
    expect(first.files[0].missing).toBeUndefined();
    expect(first.files[1].missing).toMatch(/бесплатного тарифа/);
    expect(first.files[2].missing).toMatch(/без токена/);

    expect(bundle.chats.find((c) => c.ext === 'G1')).toMatchObject({ kind: 'private', title: 'secret' });
    expect(bundle.chats.find((c) => c.ext === 'D1')).toMatchObject({ kind: 'dm', title: 'Анна Петрова и Борис', memberExts: ['U1', 'U2'] });
  });

  it('находит корень экспорта во вложенной папке', async () => {
    const opened = await openArchive('slack', await fixture('Workspace Slack export/'));
    expect(opened.bundle.chats).toHaveLength(3);
  });

  it('не принимает чужой архив', async () => {
    const zip = new JSZip();
    zip.file('readme.txt', 'привет');
    await expect(openArchive('slack', await zip.generateAsync({ type: 'nodebuffer' }))).rejects.toThrow(/не архив экспорта Slack/);
    await expect(openArchive('slack', Buffer.from('{}'))).rejects.toThrow(/\.zip/);
  });

  it('разметка Slack превращается в читаемый текст', () => {
    const names = new Map([['U1', 'Анна']]);
    const channels = new Map([['C1', 'general']]);
    expect(slackText('<@U1> <@U7|Пётр> <!here> <!subteam^S1|@дизайн> <mailto:a@b.ru|a@b.ru> <https://x.ru>', names, channels))
      .toBe('@Анна @Пётр @here @дизайн a@b.ru https://x.ru');
    expect(slackText('a &lt;b&gt; <#C1>', names, channels)).toBe('a <b> #general');
  });

  it('мелочи: время, токен, корень', () => {
    expect(slackTs('1700000000.123456')).toBe(1700000000123);
    expect(Number.isNaN(slackTs(undefined))).toBe(true);
    expect(slackUrlHasToken('https://files.slack.com/x.png?t=xoxe-1')).toBe(true);
    expect(slackUrlHasToken('https://files.slack.com/x.png')).toBe(false);
    expect(slackRoot(['a/users.json', 'a/general/users.json', 'a/channels.json'])).toBe('a/');
    expect(slackRoot(['x.txt'])).toBeNull();
  });
});
