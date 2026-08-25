import { buildIcs, escapeText, fold, icsUid } from './ics';

/**
 * Файл .ics ломается молча: почтовый клиент просто не покажет кнопку «Добавить в
 * календарь» и не скажет почему. Поэтому проверяем именно те мелочи, на которых
 * формат и спотыкается: переводы строк, экранирование, длина строк, часовой пояс.
 */
/** Клиент перед разбором «разворачивает» сложенные строки — делаем так же. */
const unfold = (ics: string) => ics.split(String.fromCharCode(13, 10) + ' ').join('');

describe('Сборка .ics', () => {
  const base = {
    uid: icsUid('2', '17'),
    title: 'Планёрка',
    startsAt: new Date(Date.UTC(2026, 7, 25, 9, 0)),
    endsAt: new Date(Date.UTC(2026, 7, 25, 10, 0)),
  };

  it('время пишется в UTC с Z — иначе встреча уедет у того, кто в другом поясе', () => {
    const ics = buildIcs(base);
    expect(ics).toContain('DTSTART:20260825T090000Z');
    expect(ics).toContain('DTEND:20260825T100000Z');
  });

  it('строки разделяются CRLF и файл заканчивается переводом строки', () => {
    const ics = buildIcs(base);
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.includes('\n\n')).toBe(false);
    // одиночных LF без CR быть не должно вовсе
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it('запятая и точка с запятой в названии экранируются, а не режут поле', () => {
    const ics = buildIcs({ ...base, title: 'Договор, правки; срочно' });
    expect(ics).toContain('SUMMARY:Договор\\, правки\\; срочно');
    expect(escapeText('строка\nвторая')).toBe('строка\\nвторая');
  });

  it('длинная строка складывается по октетам, а не по символам', () => {
    const folded = fold(`SUMMARY:${'я'.repeat(80)}`); // кириллица — два байта на символ
    const parts = folded.split('\r\n');
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(Buffer.from(p, 'utf8').length).toBeLessThanOrEqual(76);
    expect(parts.slice(1).every((p) => p.startsWith(' '))).toBe(true);
    // склеенное обратно должно давать исходный текст
    expect(parts.map((p, i) => (i ? p.slice(1) : p)).join('')).toBe(`SUMMARY:${'я'.repeat(80)}`);
  });

  it('событие на весь день заканчивается СЛЕДУЮЩИМ днём — иначе клиенты теряют последний день', () => {
    const ics = buildIcs({ ...base, allDay: true });
    expect(ics).toContain('DTSTART;VALUE=DATE:20260825');
    expect(ics).toContain('DTEND;VALUE=DATE:20260826');
  });

  it('участники и организатор попадают в файл, напоминание — отдельным блоком', () => {
    const ics = buildIcs({
      ...base,
      organizer: { name: 'Сергей', email: 'boss@t.test' },
      attendees: [{ name: 'Коллега', email: 'mate@t.test' }],
      reminders: [15],
    });
    // строка участника длиннее 75 октетов и складывается — сверяем развёрнутый текст
    expect(unfold(ics)).toContain('ORGANIZER;CN=Сергей:mailto:boss@t.test');
    expect(unfold(ics)).toContain('ATTENDEE;CN=Коллега;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:mate@t.test');
    expect(ics).toContain('BEGIN:VALARM');
    expect(ics).toContain('TRIGGER:-PT15M');
  });

  it('отмена встречи — это METHOD:CANCEL с тем же UID и выросшим номером правки', () => {
    const ics = buildIcs({ ...base, method: 'CANCEL', sequence: 2 });
    expect(ics).toContain('METHOD:CANCEL');
    expect(ics).toContain('STATUS:CANCELLED');
    expect(ics).toContain('SEQUENCE:2');
    expect(ics).toContain(`UID:${base.uid}`);
  });
});
