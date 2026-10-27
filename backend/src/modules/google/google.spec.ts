import { classifyGoogleError, grantedServices, scopesFor, SCOPES } from './google-api';
import { buildDocRequests, meetingDoc, taskDoc } from './google-docs.content';
import { dateInTz, googleEventBody, pulledEvent } from './google-calendar.rules';

describe('google-api', () => {
  it('просит разрешения по частям: Диск без Календаря и наоборот', () => {
    expect(scopesFor('drive')).toEqual(expect.arrayContaining([...SCOPES.drive]));
    expect(scopesFor('drive')).not.toEqual(expect.arrayContaining([...SCOPES.calendar]));
    expect(scopesFor('calendar')).not.toEqual(expect.arrayContaining([...SCOPES.drive]));
    expect(scopesFor('all')).toEqual(expect.arrayContaining([...SCOPES.drive, ...SCOPES.calendar]));
  });

  it('весь Диск (scope drive) не просим никогда', () => {
    expect(scopesFor('all')).not.toContain('https://www.googleapis.com/auth/drive');
  });

  it('видит, какие сервисы покрыты выданными разрешениями', () => {
    expect(grantedServices([...SCOPES.base, ...SCOPES.drive])).toEqual({ drive: true, calendar: false });
    // одно из двух разрешений календаря сняли галочкой — календаря нет
    expect(grantedServices([SCOPES.calendar[0]])).toEqual({ drive: false, calendar: false });
  });

  it('классифицирует ошибки Google', () => {
    expect(classifyGoogleError(400, { error: 'invalid_grant' }).kind).toBe('reconnect');
    expect(classifyGoogleError(401, { error: { message: 'x' } }).kind).toBe('reconnect');
    expect(classifyGoogleError(403, { error: { status: 'PERMISSION_DENIED', message: 'Request had insufficient authentication scopes.' } }).kind).toBe('scope');
    expect(classifyGoogleError(403, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }).kind).toBe('retry');
    expect(classifyGoogleError(503, {}).kind).toBe('retry');
    expect(classifyGoogleError(404, { error: { message: 'File not found' } }).kind).toBe('other');
  });
});

describe('google-docs.content', () => {
  it('вставляет весь текст одним куском и стилизует по диапазонам', () => {
    const req = buildDocRequests([
      { kind: 'title', text: 'Заголовок' },
      { kind: 'kv', key: 'Срок', value: '01.11.2026' },
      { kind: 'li', text: 'один' },
      { kind: 'li', text: 'два' },
    ]);
    expect(req[0].insertText.text).toBe('Заголовок\nСрок: 01.11.2026\nодин\nдва\n');
    expect(req[0].insertText.location.index).toBe(1);
    const title = req.find((r) => r.updateParagraphStyle)!.updateParagraphStyle;
    expect(title.range).toEqual({ startIndex: 1, endIndex: 11 });
    expect(title.paragraphStyle.namedStyleType).toBe('TITLE');
    const bold = req.find((r) => r.updateTextStyle)!.updateTextStyle;
    // «Срок:» — с 11-го по 16-й
    expect(bold.range).toEqual({ startIndex: 11, endIndex: 16 });
    // два соседних пункта — один список
    const bullets = req.filter((r) => r.createParagraphBullets);
    expect(bullets).toHaveLength(1);
    expect(bullets[0].createParagraphBullets.range).toEqual({ startIndex: 28, endIndex: 37 });
  });

  it('пустое поле не ломает индексы — ставит прочерк', () => {
    const req = buildDocRequests([{ kind: 'p', text: '' }, { kind: 'h2', text: 'Дальше' }]);
    expect(req[0].insertText.text).toBe('—\nДальше\n');
    expect(req[1].updateParagraphStyle.range).toEqual({ startIndex: 3, endIndex: 10 });
  });

  it('описание задачи из редактора идёт чистым текстом', () => {
    const blocks = taskDoc({
      title: 'Сделать отчёт', project: 'Сайт', assignee: 'Глеб', manager: null, deadline: null,
      description: '<p>Первый&nbsp;абзац</p><p>Второй <b>жирный</b></p>![скрин](/files/1)', checklist: ['a'], url: 'https://x/t/1',
    }, 'Europe/Moscow');
    const ps = blocks.filter((b) => b.kind === 'p').map((b: any) => b.text);
    expect(ps).toContain('Первый абзац');
    expect(ps).toContain('Второй жирный');
    expect(ps.join(' ')).not.toContain('скрин');
  });

  it('протокол встречи — с участниками и разделами для записи', () => {
    const blocks = meetingDoc({
      title: 'Планёрка', startsAt: new Date('2026-10-27T07:00:00Z'), endsAt: new Date('2026-10-27T08:00:00Z'),
      allDay: false, participants: ['Анна', 'Глеб'], client: null, description: null, meetUrl: 'https://q/meet/abc',
    }, 'Europe/Moscow');
    const text = buildDocRequests(blocks)[0].insertText.text;
    expect(text).toContain('Участники: Анна, Глеб');
    expect(text).toContain('27.10.2026, 10:00 — 11:00');
    expect(text).toContain('Решения');
    expect(text).toContain('Созвон: https://q/meet/abc');
  });
});

describe('google-calendar.rules', () => {
  const base: any = {
    id: '7', tenant_id: '2', title: 'Встреча', description: 'Повестка', location: null, is_private: false,
    starts_at: new Date('2026-10-27T07:00:00Z'), ends_at: new Date('2026-10-27T08:00:00Z'), all_day: false,
    is_call: true, public_id: 'abc',
  };

  it('кладёт ссылку на наш созвон и метку «это копия QEVO»', () => {
    const b = googleEventBody(base, { tz: 'Europe/Moscow', baseUrl: 'https://app.qevo.one' });
    expect(b.description).toContain('https://app.qevo.one/meet/abc');
    expect(b.location).toBe('https://app.qevo.one/meet/abc');
    expect(b.extendedProperties.private.qevoEventId).toBe('7');
    expect(b.start).toEqual({ dateTime: '2026-10-27T07:00:00.000Z', timeZone: 'Europe/Moscow' });
  });

  it('«весь день» — датами, конец исключительный', () => {
    const b = googleEventBody({ ...base, all_day: true, is_call: false,
      starts_at: new Date('2026-10-26T21:00:00Z'), ends_at: new Date('2026-10-27T20:59:00Z') },
    { tz: 'Europe/Moscow', baseUrl: 'https://q' });
    expect(b.start).toEqual({ date: '2026-10-27' });
    expect(b.end).toEqual({ date: '2026-10-28' });
  });

  it('дата в поясе компании, а не сервера', () => {
    expect(dateInTz(new Date('2026-10-26T22:30:00Z'), 'Europe/Moscow')).toBe('2026-10-27');
    expect(dateInTz(new Date('2026-10-26T22:30:00Z'), 'UTC')).toBe('2026-10-26');
  });

  it('из Google не тянет отменённые, свободные и отклонённые', () => {
    const ok = { id: 'g1', summary: 'Клиент', start: { dateTime: '2026-10-27T10:00:00+03:00' }, end: { dateTime: '2026-10-27T11:00:00+03:00' } };
    expect(pulledEvent(ok)).toMatchObject({ uid: 'g1', title: 'Клиент', allDay: false });
    expect(pulledEvent({ ...ok, status: 'cancelled' })).toBeNull();
    expect(pulledEvent({ ...ok, transparency: 'transparent' })).toBeNull();
    expect(pulledEvent({ ...ok, attendees: [{ self: true, responseStatus: 'declined' }] })).toBeNull();
    expect(pulledEvent({ id: 'g2', start: { date: '2026-10-27' }, end: { date: '2026-10-28' } }))
      .toMatchObject({ allDay: true, title: 'Занято' });
  });
});
