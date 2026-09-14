#!/usr/bin/env node
/**
 * Проверки чистой логики фронтенда без браузера и без тест-раннера.
 *
 * Зачем так: во фронте нет ни одной зависимости, и тащить vitest с jsdom ради трёх
 * модулей дорого. А проверять их надо — это ровно те места, которые ошибаются молча:
 * разбор адреса (ссылка на задачу открывается не туда), порядок в командной строке
 * (совпадение есть, но уехало вниз и человек решил, что не нашлось), кэш (показывает
 * вчерашние данные или, наоборот, ходит в сеть на каждый чих).
 *
 * Модули собираются esbuild'ом (он и так стоит вместе с vite) и проверяются обычным
 * node:assert. UI сюда не входит — его проверяют глазами и e2e бэкенда.
 *
 * Запуск: npm run check (в CI — рядом с линтером).
 */
import { build } from 'esbuild';
import assert from 'node:assert/strict';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync, rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'node_modules', '.cache', 'logic-check');

async function load(rel) {
  const outfile = join(OUT, rel.replace(/[\\/]/g, '_') + '.mjs');
  await build({
    entryPoints: [join(ROOT, 'src', rel)],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    logLevel: 'error',
  });
  return import(pathToFileURL(outfile).href);
}

const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ── адреса ────────────────────────────────────────────────────────────────────
test('разбор и сборка адреса совпадают в обе стороны', async () => {
  const { parsePath, buildPath } = await load('lib/router.ts');
  const routes = [
    ['/focus', { section: 'focus' }],
    ['/focus/inbox', { section: 'focus', view: 'inbox' }],
    ['/calendar', { section: 'calendar' }],
    ['/tasks', { section: 'tasks' }],
    ['/tasks/delegated', { section: 'tasks', view: 'delegated' }],
    ['/projects', { section: 'projects' }],
    ['/projects/p1', { section: 'projects', projectId: 'p1' }],
    ['/projects/p1/task/t2', { section: 'projects', projectId: 'p1', taskId: 't2' }],
    ['/chat', { section: 'chat' }],
    ['/chat/meetings', { section: 'chat', view: 'meetings' }],
    ['/chat/c9', { section: 'chat', chatId: 'c9' }],
    ['/radar', { section: 'radar' }],
    ['/settings', { section: 'settings' }],
    ['/settings/integrations', { section: 'settings', tab: 'integrations' }],
    ['/profile', { section: 'profile' }],
  ];
  for (const [path, expected] of routes) {
    assert.deepEqual(parsePath(path), expected, `разбор ${path}`);
    assert.equal(buildPath(parsePath(path)), path, `сборка ${path}`);
  }

  // старый адрес календаря разослан в письмах-приглашениях и лежит в закладках:
  // он обязан открывать новый раздел, а не выкидывать в «Фокус дня»
  assert.deepEqual(parsePath('/focus/calendar'), { section: 'calendar' }, 'старая ссылка на календарь');
  assert.equal(buildPath({ section: 'calendar' }), '/calendar');
});

test('мусорный адрес не роняет приложение, а открывает фокус', async () => {
  const { parsePath } = await load('lib/router.ts');
  for (const p of ['/', '/nope', '/projects/p1/task', '/chat//', '//']) {
    assert.ok(parsePath(p).section, `нет раздела для ${p}`);
  }
  assert.equal(parsePath('/nope').section, 'focus');
});

test('идентификатор со слэшем и кириллицей переживает круг', async () => {
  const { parsePath, buildPath } = await load('lib/router.ts');
  const route = { section: 'projects', projectId: 'a/b', taskId: 'зада ча' };
  assert.deepEqual(parsePath(buildPath(route)), route);
});

// ── порядок в командной строке ────────────────────────────────────────────────
test('совпадение в начале названия выше, чем внутри слова', async () => {
  const { score, norm } = await load('lib/palette-match.ts');
  assert.equal(score('Маркетинг', 'мар'), 0);
  assert.equal(score('Запуск маркетинга', 'мар'), 1);
  assert.equal(score('Ремарки по договору', 'мар'), 2);
  assert.equal(score('Проект «Маркетинг»', 'мар'), 1);
  assert.equal(score('Бухгалтерия', 'мар'), null);
  assert.equal(score('Всё о ёлках', 'все о ел'), 0, 'ё и е должны считаться одинаковыми');
  assert.equal(score('Что угодно', '   '), 0, 'пустой запрос пропускает всё');
  assert.equal(norm('  ЁЖИК '), 'ежик');

  const sorted = ['Ремарки по договору', 'Запуск маркетинга', 'Маркетинг']
    .map((t) => ({ t, r: score(t, 'мар') }))
    .sort((a, b) => a.r - b.r || a.t.localeCompare(b.t, 'ru'))
    .map((x) => x.t);
  assert.deepEqual(sorted, ['Маркетинг', 'Запуск маркетинга', 'Ремарки по договору']);
});

// ── быстрые команды ───────────────────────────────────────────────────────────
test('команда находится по обрывку фразы и по синониму', async () => {
  const { findCommands, matchCommand, COMMANDS } = await load('lib/commands.ts');
  const byKind = (q, manager = true) => findCommands(q, manager).map((c) => c.kind);

  assert.ok(byKind('не бесп').includes('focus-deep-hour'), 'обрывок фразы должен срабатывать');
  assert.ok(byKind('dnd').includes('focus-deep-hour'), 'синоним тоже');
  assert.ok(byKind('обед').includes('focus-break'));
  assert.ok(byKind('созвон').includes('focus-call'));
  assert.ok(byKind('кто свободен').includes('who-free'));
  assert.ok(byKind('тёмная').includes('theme-dark'), 'ё в запросе не должна мешать');
  assert.ok(byKind('темная').includes('theme-dark'), 'и её отсутствие тоже');
  assert.ok(byKind('просроч').includes('my-overdue'));
  assert.ok(byKind('сводка').includes('day-summary'));

  assert.deepEqual(byKind('щщщ'), [], 'бессмыслица не должна что-то находить');
  assert.deepEqual(byKind('а'), [], 'одна буква — это ещё не запрос');

  // команда руководителя рядовому сотруднику не показывается
  assert.ok(byKind('под риском', true).includes('at-risk'));
  assert.ok(!byKind('под риском', false).includes('at-risk'), 'сотрудник не должен видеть чужой экран');

  // у каждой команды есть слова-зацепки и она находится по собственному названию
  for (const c of COMMANDS) {
    assert.ok(c.words.length > 0, `у команды ${c.kind} нет слов-зацепок`);
    assert.ok(matchCommand(c, c.title), `команда ${c.kind} не находится по своему названию`);
  }
});

// ── часовые пояса ─────────────────────────────────────────────────────────────
test('пояса считаются и подписываются как в системных настройках', async () => {
  const { offsetMinutes, formatOffset, listTimezones, browserTimezone } = await load('lib/timezones.ts');

  // Москва круглый год +3: перевода часов там нет с 2014-го
  assert.equal(offsetMinutes('Europe/Moscow', new Date('2026-01-15T12:00:00Z')), 180, 'зимой');
  assert.equal(offsetMinutes('Europe/Moscow', new Date('2026-07-15T12:00:00Z')), 180, 'летом');
  assert.equal(offsetMinutes('UTC', new Date('2026-01-15T12:00:00Z')), 0);

  // А в Берлине перевод есть — и список обязан показывать действующее смещение
  const winter = offsetMinutes('Europe/Berlin', new Date('2026-01-15T12:00:00Z'));
  const summer = offsetMinutes('Europe/Berlin', new Date('2026-07-15T12:00:00Z'));
  assert.equal(winter, 60);
  assert.equal(summer, 120, 'летнее время в Европе должно учитываться');

  // Индия и Непал — не целые часы; из-за них нельзя считать смещение в часах
  assert.equal(offsetMinutes('Asia/Kolkata', new Date('2026-01-15T12:00:00Z')), 330);
  assert.equal(offsetMinutes('Asia/Kathmandu', new Date('2026-01-15T12:00:00Z')), 345);

  // Западное полушарие — отрицательное смещение с типографским минусом в подписи
  assert.ok(offsetMinutes('America/New_York', new Date('2026-01-15T12:00:00Z')) < 0);
  assert.equal(formatOffset(180), '+03:00');
  assert.equal(formatOffset(0), '+00:00');
  assert.equal(formatOffset(345), '+05:45');
  assert.equal(formatOffset(-300), '−05:00');

  // Неизвестный пояс не роняет экран настроек
  assert.equal(offsetMinutes('Нет/Такого', new Date()), 0);

  const list = listTimezones(new Date('2026-01-15T12:00:00Z'));
  assert.ok(list.length > 20, 'список должен быть полным, а не из десятка городов');
  assert.ok(list.some((z) => z.id === 'Europe/Moscow'), 'Москва обязана быть в списке');
  assert.ok(list.find((z) => z.id === 'Europe/Moscow').label.startsWith('(UTC+03:00) Москва'),
    'подпись — как в системных настройках');
  // порядок по смещению: список читают сверху вниз и ищут глазами свой сдвиг
  for (let i = 1; i < list.length; i++) {
    assert.ok(list[i].offset >= list[i - 1].offset, 'список должен идти по возрастанию смещения');
  }
  assert.ok(typeof browserTimezone() === 'string' && browserTimezone().length > 0);
});

// ── кэш ───────────────────────────────────────────────────────────────────────
test('кэш схлопывает одновременные запросы и уважает срок годности', async () => {
  const { cached, dropCache } = await load('lib/cache.ts');
  let calls = 0;
  const fetchOne = () => { calls++; return Promise.resolve('A'); };

  const [a, b] = await Promise.all([cached('k', fetchOne), cached('k', fetchOne)]);
  assert.equal(calls, 1, 'одновременные запросы должны схлопнуться в один');
  assert.equal(a, b, 'оба получают один результат');

  await cached('k', fetchOne);
  assert.equal(calls, 1, 'повтор внутри срока годности не идёт в сеть');

  await cached('k', fetchOne, 0);
  assert.equal(calls, 2, 'после истечения срока запрос повторяется');

  await cached('focus:mine', fetchOne);
  await cached('radar', fetchOne);
  const before = calls;
  dropCache('focus:');
  await cached('radar', fetchOne);
  assert.equal(calls, before, 'сброс по префиксу не должен трогать чужую ветку');
  await cached('focus:mine', fetchOne);
  assert.equal(calls, before + 1, 'своя ветка после сброса перечитывается');

  dropCache();
  await cached('radar', fetchOne);
  assert.equal(calls, before + 2, 'полный сброс очищает всё');
});

test('неудачный запрос не кэшируется', async () => {
  const { cached } = await load('lib/cache.ts');
  let fails = 0;
  const boom = () => { fails++; return Promise.reject(new Error('нет сети')); };
  await cached('bad', boom).catch(() => undefined);
  await cached('bad', boom).catch(() => undefined);
  assert.equal(fails, 2, 'иначе одна сетевая ошибка залипала бы на весь срок годности');
});

test('звук молчит, когда его выключили или когда «не беспокоить»', async () => {
  // Браузера здесь нет: подменяем ровно то, чем пользуется модуль, и считаем ноты.
  let notes = 0;
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
  };
  class FakeCtx {
    state = 'running';
    currentTime = 0;
    resume() {}
    createGain() { return { gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {} }, connect() {} }; }
    createOscillator() {
      notes++;
      return { type: '', frequency: { setValueAtTime() {} }, connect() {}, start() {}, stop() {} };
    }
    get destination() { return {}; }
  }
  globalThis.window = { AudioContext: FakeCtx, addEventListener() {}, removeEventListener() {} };

  const sound = await load('lib/sound.ts');

  assert.deepEqual(sound.soundPrefs(), { messages: true, calls: true }, 'по умолчанию звук включён');

  sound.playMessageChime();
  assert.equal(notes, 2, 'сигнал о сообщении — две ноты');

  sound.setSoundPref('messages', false);
  notes = 0;
  sound.playMessageChime();
  assert.equal(notes, 0, 'выключенный сигнал не звучит');

  sound.setSoundPref('messages', true);
  sound.setDoNotDisturb(true);
  notes = 0;
  sound.playMessageChime();
  sound.startRingtone();
  assert.equal(notes, 0, '«не беспокоить» глушит и сигнал, и звонок');

  sound.setDoNotDisturb(false);
  notes = 0;
  sound.startRingtone();
  const afterFirst = notes;
  assert.ok(afterFirst > 0, 'звонок звучит сразу, а не через период повтора');
  sound.startRingtone(); // второй вызов не должен наслаивать второй звонок поверх первого
  assert.equal(notes, afterFirst, 'повторный старт звонка ничего не добавляет');
  sound.stopRingtone();

  delete globalThis.window;
  delete globalThis.localStorage;
});

test('календарь: срочное, важное и просроченное отличаются', async () => {
  const { dueMark, DUE_LABEL } = await load('lib/calendar-grid.ts');
  const now = new Date(2026, 8, 8, 12, 0);
  const at = (d, over = {}) => ({ deadline_at: d.toISOString(), ...over });

  // порядок проверок и есть смысл: сделанное молчит, просроченное важнее приоритета
  assert.equal(dueMark(at(new Date(2026, 8, 1), { closed_at: '2026-09-02T10:00:00Z', priority: 'urgent' }), now), 'done');
  assert.equal(dueMark(at(new Date(2026, 8, 7), { priority: 'low' }), now), 'overdue');
  assert.equal(dueMark(at(new Date(2026, 8, 9), { priority: 'urgent' }), now), 'urgent');
  assert.equal(dueMark(at(new Date(2026, 8, 9), { priority: 'high' }), now), 'high');
  assert.equal(dueMark(at(new Date(2026, 8, 9), { priority: 'normal' }), now), 'normal');
  assert.equal(dueMark(at(new Date(2026, 8, 9)), now), 'normal', 'без приоритета — обычный срок');

  // у каждой метки есть подпись: цвет один ничего не объясняет тем, кто его не различает
  for (const key of ['done', 'overdue', 'urgent', 'high', 'normal']) {
    assert.ok(DUE_LABEL[key], `нет подписи для метки ${key}`);
  }
});

test('календарь раскладывает события по дням и колонкам', async () => {
  const g = await load('lib/calendar-grid.ts');

  // неделя начинается с понедельника: у нас рабочая неделя, а не американская
  const wed = new Date(2026, 7, 26, 15, 0); // среда, 26 августа 2026
  assert.equal(g.startOfWeek(wed).getDay(), 1, 'неделя должна начинаться с понедельника');
  assert.equal(g.daysOf('week', wed).length, 7);
  assert.equal(g.daysOf('day', wed).length, 1);
  assert.equal(g.daysOf('month', wed).length % 7, 0, 'месяц отдаёт целые недели, иначе сетка кривая');

  const days = g.daysOf('week', wed);

  // событие через полночь обязано быть видно в ОБОИХ днях, а не исчезнуть из вчерашнего
  const overnight = { id: '1', title: 'ночная', startsAt: new Date(2026, 7, 26, 23, 0).toISOString(), endsAt: new Date(2026, 7, 27, 1, 0).toISOString() };
  const parts = g.splitByDay(overnight, days);
  assert.equal(parts.length, 2, 'событие через полночь режется на два дня');
  assert.ok(parts[0].continuesTo && parts[1].continuesFrom, 'обе части знают о продолжении');
  assert.ok(parts[0].top + parts[0].height <= 1.0001, 'первая часть не вылезает за сутки');
  assert.ok(Math.abs(parts[1].top) < 1e-9, 'вторая часть начинается с полуночи');

  // событие вне окна не показывается вовсе
  const far = { id: '2', title: 'через месяц', startsAt: new Date(2026, 8, 26, 10, 0).toISOString(), endsAt: new Date(2026, 8, 26, 11, 0).toISOString() };
  assert.equal(g.splitByDay(far, days).length, 0);

  // пятиминутная встреча не должна стать невидимой полоской
  const tiny = { id: '3', title: 'пять минут', startsAt: new Date(2026, 7, 26, 10, 0).toISOString(), endsAt: new Date(2026, 7, 26, 10, 5).toISOString() };
  assert.ok(g.splitByDay(tiny, days)[0].height >= 0.02);

  // два события на одно время встают рядом, а не друг на друга
  const a = { id: 'a', title: 'A', startsAt: new Date(2026, 7, 26, 10, 0).toISOString(), endsAt: new Date(2026, 7, 26, 11, 0).toISOString() };
  const b = { id: 'b', title: 'B', startsAt: new Date(2026, 7, 26, 10, 30).toISOString(), endsAt: new Date(2026, 7, 26, 11, 30).toISOString() };
  const c = { id: 'c', title: 'C', startsAt: new Date(2026, 7, 26, 12, 0).toISOString(), endsAt: new Date(2026, 7, 26, 13, 0).toISOString() };
  const laid = g.layoutDay([a, b, c].flatMap((e) => g.splitByDay(e, [days[2]])));
  const byId = Object.fromEntries(laid.map((s) => [s.event.id, s]));
  assert.equal(byId.a.columns, 2, 'пересекающиеся события делят день на две колонки');
  assert.notEqual(byId.a.column, byId.b.column, 'наложенные события в разных колонках');
  assert.equal(byId.c.columns, 1, 'непересекающееся событие занимает всю ширину');

  // выходные и праздники — по настройке организации
  const work = { weekendDays: [0, 6], holidays: ['2026-08-26'] };
  assert.ok(g.isDayOff(new Date(2026, 7, 29), work), 'суббота — выходной');
  assert.ok(g.isDayOff(new Date(2026, 7, 26), work), 'праздник — выходной, даже если это среда');
  assert.ok(!g.isDayOff(new Date(2026, 7, 27), work), 'обычный четверг — рабочий');

  assert.equal(g.timeToFraction('09:00'), 0.375);
  assert.equal(g.timeToFraction('мусор'), 0);
});

test('упоминания: подсказка открывается по делу, а разбор не выдумывает людей', async () => {
  const m = await load('lib/mentions.ts');
  const team = [
    { id: '1', fullName: 'Иван Петров' },
    { id: '2', fullName: 'Иван' },
    { id: '3', fullName: 'Ольга Ким' },
  ];

  // подсказка: @ в начале слова — да, внутри адреса почты — нет
  assert.deepEqual(m.activeQuery('привет @Ив', 10), { start: 7, query: 'Ив' });
  assert.equal(m.activeQuery('mail@teamsmrt.com', 17), null, 'адрес почты не упоминание');
  assert.equal(m.activeQuery('@Иван Петров сделал всё и ушёл', 30), null, 'предложение — уже не поиск');

  // ищем по любой части имени, а не только по началу
  assert.deepEqual(m.suggest(team, 'петров').map((u) => u.id), ['1']);
  assert.equal(m.suggest(team, '').length, 3, 'пустой запрос — вся команда');

  // разбор: длинное имя выигрывает у короткого, посторонний @ остаётся текстом
  const parts = m.withMentions('@Иван Петров, посмотрите. Цена @2000', team);
  assert.deepEqual(parts[0], { name: 'Иван Петров' }, 'совпасть должно длинное имя');
  assert.ok(parts.slice(1).every((p) => typeof p === 'string'), '@2000 — не человек');

  // стёртое имя не зовёт: человек передумал
  assert.deepEqual(m.stillMentioned(['1', '3'], 'спасибо, @Иван Петров', team), ['1']);
});

test('праздники: фиксированные даты по ТК, без переносов и без дублей', async () => {
  const h = await load('lib/holidays.ts');

  const y = h.ruHolidays(2026);
  const dates = y.map((x) => x.date);
  assert.equal(dates.length, 14, 'нерабочих праздничных дней по статье 112 — четырнадцать');
  assert.ok(dates.includes('2026-01-07'), 'Рождество');
  assert.ok(dates.includes('2026-02-23'), 'День защитника Отечества');
  assert.ok(dates.includes('2026-11-04'), 'День народного единства');
  assert.equal(new Set(dates).size, dates.length, 'дублей быть не должно');
  // переносы не выдумываем: их правительство утверждает отдельно на каждый год
  assert.ok(!dates.includes('2026-01-09'), 'перенесённых дней в списке нет');

  // подстановка не вытирает то, что владелец внёс руками
  const merged = h.mergeHolidays(['2026-05-04', '2026-01-01'], dates);
  assert.ok(merged.includes('2026-05-04'), 'ручной перенос остался');
  assert.equal(merged.filter((d) => d === '2026-01-01').length, 1, 'повтор не задвоился');
  assert.deepEqual(merged, [...merged].sort(), 'список отсортирован');

  assert.equal(h.humanDate('2026-01-01'), '1 января 2026');
  assert.equal(h.humanDate('мусор'), 'мусор');

  // неделя начинается с понедельника, воскресенье — последнее
  assert.deepEqual(h.WEEK_DAYS.map((d) => d.value), [1, 2, 3, 4, 5, 6, 0]);
});

test('напоминания: подписи, своё время и защита от дублей', async () => {
  const r = await load('lib/reminders.ts');

  assert.equal(r.reminderLabel(0), 'в момент начала', 'ноль — это начало, а не «за 0 минут»');
  assert.equal(r.reminderLabel(5), 'за 5 мин');
  assert.equal(r.reminderLabel(60), 'за 1 ч');
  assert.equal(r.reminderLabel(90), 'за 1 ч 30 мин');
  assert.equal(r.reminderLabel(1440), 'за 1 дн.');
  assert.equal(r.reminderLabel(1500), 'за 1 дн. 1 ч');

  assert.equal(r.toMinutes(2, 'hours'), 120);
  assert.equal(r.toMinutes(1, 'days'), 1440);
  assert.ok(Number.isNaN(r.toMinutes(-5, 'minutes')), 'отрицательное время не принимаем');

  // добавление своего значения
  assert.deepEqual(r.addReminder([15, 60], 45), [15, 45, 60], 'встаёт по возрастанию');
  assert.deepEqual(r.addReminder([15, 60], 15), [15, 60], 'дубль не добавляется');
  assert.deepEqual(r.addReminder([15], 99999), [15], 'дальше двух недель не напоминаем');
  const full = [0, 5, 15, 60, 120, 1440];
  assert.deepEqual(r.addReminder(full, 30), full, 'больше шести напоминаний не набирается');

  // в форме своё значение показывается наравне со стандартными
  const rows = r.reminderRows([5, 45, 60], [0, 5, 15, 60, 1440]);
  assert.deepEqual(rows.map((x) => x.minutes), [0, 5, 15, 45, 60, 1440]);
  assert.equal(rows.find((x) => x.minutes === 45).custom, true);
  assert.equal(rows.find((x) => x.minutes === 15).custom, false);
});

test('меню сообщения раскрывается вниз, когда сверху места нет, и не уезжает за край', async () => {
  const { placePopover } = await load('lib/popover.ts');

  // Ветка обсуждения: первое сообщение у самого верха панели. Раньше меню
  // раскрывалось вверх и обрезалось прокруткой — со стороны «ничего не работает».
  const top = placePopover({ left: 900, top: 90, bottom: 118 }, 264, 1440);
  assert.equal(top.up, false, 'сверху 90 пикселей — на меню в 264 их не хватит');
  assert.equal(top.y, 124, 'раскрываемся вниз от нижнего края кнопки');

  // Середина ленты: места сверху достаточно — ведём себя как привычные мессенджеры.
  const mid = placePopover({ left: 300, top: 600, bottom: 628 }, 264, 1440);
  assert.equal(mid.up, true);
  assert.equal(mid.y, 594, 'точка привязки — верх кнопки, всплывашка уходит выше');

  // Маленький набор смайлов помещается там, где меню уже нет.
  assert.equal(placePopover({ left: 300, top: 90, bottom: 118 }, 48, 1440).up, true);

  // Узкое окно и кнопка у правого края: меню прижимается, но не вылезает.
  const edge = placePopover({ left: 1380, top: 600, bottom: 628 }, 264, 1440);
  assert.equal(edge.x, 1440 - 232 - 8, 'прижали к правому краю с отступом');
  assert.ok(edge.x + 232 <= 1440, 'за границу окна не вышли');

  // Совсем узкий экран: левый отступ важнее прижатия вправо.
  assert.equal(placePopover({ left: 4, top: 600, bottom: 628 }, 264, 320).x, 8);
});

test('виды задач на доске: делаю, помогаю, поручил, наблюдаю', async () => {
  const { filterBoard, countMatching, realPosition, filterActive } = await load('lib/board-filter.ts');
  // t1 — моя работа, t2 — я поставил другому, t3 — чужая целиком, t4 — я и поставил, и делаю
  const columns = [
    { id: 'c1', name: 'В работе', tasks: [
      { id: 't1', assignee_id: '7', created_by: '9' },
      { id: 't2', assignee_id: '9', created_by: '7' },
    ] },
    { id: 'c2', name: 'Проверка', tasks: [{ id: 't3', assignee_id: '9', created_by: '9' }] },
    { id: 'c3', name: 'Готово', tasks: [{ id: 't4', assignee_id: '7', created_by: '7' }] },
  ];
  const me = (mode, creatorId) => ({ userId: '7', mode, creatorId });

  // «Делаю» и «Помогаю» — РАЗНЫЕ виды: исполнитель отвечает за результат,
  // соисполнитель помогает. В одной куче человек не видел, где с него спросят.
  const withCo = [{ id: 'c', name: 'x', tasks: [{ id: 't9', assignee_id: '9', created_by: '9', co_assignees: [{ userId: '7' }] }] }];
  assert.equal(countMatching(withCo, me('helping')), 1, 'соисполнитель находит свою помощь');
  assert.equal(countMatching(withCo, me('doing')), 0, 'но исполнителем от этого не становится');
  assert.equal(countMatching(withCo, me('delegated')), 0, 'и постановщиком тоже');
  assert.equal(countMatching(withCo, me('both')), 1, '«вся моя работа» помощь включает');

  const withWatch = [{ id: 'c', name: 'x', tasks: [{ id: 't8', assignee_id: '9', created_by: '9', watchers: [{ userId: '7' }] }] }];
  assert.equal(countMatching(withWatch, me('watching')), 1);
  assert.equal(countMatching(withWatch, me('doing')), 0, 'наблюдатель ничего не делает');
  assert.equal(countMatching(withWatch, me('both')), 0, 'и в «мою работу» не попадает');

  // «Делаю» и «Поручил» — разные списки, и это главное различие
  assert.deepEqual(
    filterBoard(columns, me('doing')).flatMap((c) => c.tasks.map((t) => t.id)),
    ['t1', 't4'],
  );
  assert.deepEqual(
    filterBoard(columns, me('delegated')).flatMap((c) => c.tasks.map((t) => t.id)),
    ['t2', 't4'],
  );
  // «Вся моя работа» — обе роли разом, без дублей
  assert.deepEqual(
    filterBoard(columns, me('both')).flatMap((c) => c.tasks.map((t) => t.id)),
    ['t1', 't2', 't4'],
  );

  // «Только в работе» отсекает завершённое и работает вместе с любым видом
  const withDone = [{ id: 'c', name: 'x', tasks: [
    { id: 'open', assignee_id: '7' },
    { id: 'done', assignee_id: '7', closed_at: '2026-09-01T10:00:00Z' },
  ] }];
  assert.equal(countMatching(withDone, { userId: '7', mode: 'doing' }), 2);
  assert.equal(countMatching(withDone, { userId: '7', mode: 'doing', inWorkOnly: true }), 1);
  assert.equal(countMatching(withDone, { userId: '7', mode: 'off', inWorkOnly: true }), 1, 'работает и без выбранного вида');
  assert.equal(filterActive({ mode: 'off', inWorkOnly: true }), true, '«только в работе» — тоже фильтр');

  // Постановщик работает независимо от исполнителя: всё, что человек раздал
  assert.deepEqual(
    filterBoard(columns, { userId: '7', mode: 'off', creatorId: '9' }).flatMap((c) => c.tasks.map((t) => t.id)),
    ['t1', 't3'],
  );
  // ...и сужает выбор вместе с режимом, а не вместо него
  assert.deepEqual(
    filterBoard(columns, me('doing', '9')).flatMap((c) => c.tasks.map((t) => t.id)),
    ['t1'],
  );

  // список: пустые колонки не показываем; доска: колонки остаются, иначе бросать некуда
  assert.deepEqual(filterBoard(columns, me('doing')).map((c) => c.id), ['c1', 'c3']);
  assert.deepEqual(filterBoard(columns, me('doing'), true).map((c) => c.id), ['c1', 'c2', 'c3']);

  assert.equal(countMatching(columns, me('doing')), 2);
  assert.equal(countMatching(columns, me('delegated')), 2);
  assert.equal(countMatching(columns, me('both')), 3, 'задача, где я и постановщик, и исполнитель, — одна');
  assert.equal(countMatching(columns, { userId: '42', mode: 'both' }), 0, 'чужой человек не находит своих');
  // id приходят и строкой, и числом; задача без исполнителя ничья
  assert.equal(countMatching([{ id: 'c', name: 'x', tasks: [{ id: 't', assignee_id: 7 }] }], me('doing')), 1);
  assert.equal(countMatching([{ id: 'c', name: 'x', tasks: [{ id: 't', assignee_id: null }] }], me('doing')), 0);
  assert.equal(countMatching([{ id: 'c', name: 'x', tasks: [{ id: 't', created_by: null }] }], me('delegated')), 0);

  assert.equal(filterActive({ mode: 'off' }), false);
  assert.equal(filterActive({ mode: 'off', creatorId: '9' }), true, 'выбранный постановщик — тоже фильтр');
  assert.equal(filterActive({ mode: 'delegated' }), true);

  // перенос при фильтре: индекс среди видимых → настоящее место в полной колонке
  const full = [
    { id: 'a', assignee_id: '9' },
    { id: 'b', assignee_id: '7' },
    { id: 'c', assignee_id: '9' },
    { id: 'd', assignee_id: '7' },
  ];
  const opts = { userId: '7', mode: 'doing' };
  assert.equal(realPosition(full, opts, 0), 1, 'выше своей первой — на её место');
  assert.equal(realPosition(full, opts, 1), 3, 'между своими — на место второй своей, а не в начало');
  assert.equal(realPosition(full, opts, 2), 4, 'ниже последней своей — в конец колонки');
  assert.equal(realPosition([], opts, 0), 0, 'пустая колонка');
  assert.equal(realPosition([{ id: 'x', assignee_id: '9' }], opts, 0), 1, 'видимых нет — в конец');
});

test('личный порядок меню: переставили, спрятали, пережили обновление системы', async () => {
  const { applyOrder, applyHidden, isHidden, moveItem, toggleHidden, PROTECTED } = await load('lib/menu-order.ts');
  const items = ['focus', 'calendar', 'projects', 'chat', 'radar', 'settings'].map((section) => ({ section }));
  const keys = (list) => list.map((i) => i.section);

  // без настройки — исходный порядок
  assert.deepEqual(keys(applyOrder(items)), ['focus', 'calendar', 'projects', 'chat', 'radar', 'settings']);

  // человек поставил переписку первой
  const prefs = { order: ['chat', 'projects', 'focus'] };
  assert.deepEqual(
    keys(applyOrder(items, prefs)),
    ['chat', 'projects', 'focus', 'calendar', 'radar', 'settings'],
    'разделы, которых нет в сохранённом порядке, встают в конец, а не пропадают',
  );

  // в настройке остался раздел, которого больше нет в системе
  assert.deepEqual(
    keys(applyOrder(items, { order: ['inbox', 'chat'] })),
    ['chat', 'focus', 'calendar', 'projects', 'radar', 'settings'],
    'исчезнувший раздел не ломает список',
  );

  // скрытие
  const hiddenPrefs = { hidden: ['radar'] };
  assert.deepEqual(keys(applyHidden(items, hiddenPrefs)), ['focus', 'calendar', 'projects', 'chat', 'settings']);
  assert.equal(isHidden('radar', hiddenPrefs), true);
  assert.equal(isHidden('chat', hiddenPrefs), false);

  // системный раздел спрятать нельзя — иначе из интерфейса не выбраться
  assert.deepEqual(PROTECTED, ['settings']);
  assert.deepEqual(toggleHidden([], 'settings'), []);
  assert.deepEqual(keys(applyHidden(items, { hidden: ['settings'] })).includes('settings'), true);

  // перестановка возвращает ПОЛНЫЙ порядок: сохранять «дельту» нельзя
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'c', 0), ['c', 'a', 'b']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'a', 2), ['b', 'c', 'a']);
  assert.deepEqual(moveItem(['a', 'b', 'c'], 'a', 99), ['b', 'c', 'a'], 'за пределы списка не уезжает');
  assert.deepEqual(moveItem(['a', 'b'], 'x', 0), ['a', 'b'], 'неизвестный пункт ничего не двигает');

  assert.deepEqual(toggleHidden(['radar'], 'radar'), [], 'повторное нажатие возвращает раздел');
});

// ── свёрнутый созвон ──────────────────────────────────────────────────────────
test('в свёрнутом окне видно того, кто говорит', async () => {
  const { miniOrder, initials, loudest, miniNote, callTime } = await load('lib/call-mini.ts');
  const p = (id, over = {}) => ({ id, name: id, hasVideo: false, isSelf: false, ...over });

  const people = [p('me', { isSelf: true, hasVideo: true }), p('a'), p('b', { hasVideo: true }), p('ai', { isAi: true })];
  // говорящий впереди всех, своё лицо — последним: место тратится на собеседников
  assert.deepEqual(miniOrder(people, 'a').map((x) => x.id), ['a', 'b', 'ai', 'me']);
  // без говорящего вперёд выходит тот, у кого включена камера
  assert.deepEqual(miniOrder(people, null).map((x) => x.id), ['b', 'a', 'ai', 'me']);
  // «говорю я» окно не переворачивает: смотреть на себя незачем
  assert.deepEqual(miniOrder(people, 'me')[0].id, 'b');
  assert.equal(miniOrder(people, null, 2).length, 2, 'больше плиток, чем влезает, не отдаём');
  assert.equal(miniOrder([p('one')], null).length, 1);

  assert.equal(initials('Сергей Попович'), 'СП');
  assert.equal(initials('Борис'), 'Б');
  assert.equal(initials('Иван Петров (гость)'), 'ИП', 'пометка в скобках в инициалы не идёт');
  assert.equal(initials('  '), '?', 'пустое имя не должно рисовать пустой кружок');

  // порог отсекает шум, иначе «говорящим» становится вентилятор
  assert.equal(loudest({ a: 0.01, b: 0.02 }, 0.045), null);
  assert.equal(loudest({ a: 0.01, b: 0.2 }, 0.045), 'b');
  // прежний говорящий держится на стыке фраз: иначе плитки мигают
  assert.equal(loudest({ a: 0.19, b: 0.2 }, 0.045, 'a'), 'a');
  assert.equal(loudest({ a: 0.05, b: 0.3 }, 0.045, 'a'), 'b', 'заметно громче — переключаемся');
  assert.equal(loudest({ a: 0.01 }, 0.045, 'a'), null, 'замолчавший говорящим не остаётся');

  assert.equal(miniNote(1, false), 'вы одни');
  assert.equal(miniNote(3, true), 'на связи: 3 · идёт запись');

  // часы на кнопке возврата: убранный созвон только ими и виден
  assert.equal(callTime(0), '0:00');
  assert.equal(callTime(64), '1:04');
  assert.equal(callTime(3600 + 7 * 60 + 4), '1:07:04');
  assert.equal(callTime(-5), '0:00', 'часы не идут назад даже при кривом времени системы');
});

// ── потоки собеседников ───────────────────────────────────────────────────────
test('новый показ экрана вытесняет прежний показ того же человека', async () => {
  const { mergeTrack, currentScreen } = await load('lib/call-mini.ts');
  const t = (consumerId, userId, over = {}) => ({ consumerId, userId, kind: 'video', screen: false, ...over });

  // тот же поток пришёл дважды (пауза и возврат) — в списке остаётся один
  assert.deepEqual(mergeTrack([t('c1', 'u1')], t('c1', 'u1')).map((x) => x.consumerId), ['c1']);

  // ГЛАВНОЕ: второй показ экрана того же человека убирает застрявший первый,
  // иначе на сцену попадала мёртвая дорожка и все видели чёрный прямоугольник
  const after = mergeTrack(
    [t('cam', 'u1'), t('scr1', 'u1', { screen: true }), t('scr9', 'u2', { screen: true })],
    t('scr2', 'u1', { screen: true }),
  );
  assert.deepEqual(after.map((x) => x.consumerId), ['cam', 'scr9', 'scr2']);
  assert.equal(currentScreen(after).consumerId, 'scr2', 'на сцене самый свежий показ');

  // камеру показ экрана не трогает: это разные дорожки одного человека
  const withCam = mergeTrack(after, t('cam2', 'u1'));
  assert.equal(withCam.filter((x) => x.userId === 'u1' && !x.screen).length, 2);

  assert.equal(currentScreen([t('c1', 'u1'), { ...t('a', 'u2'), kind: 'audio', screen: true }]), null,
    'звук показом экрана не считается');
});

// ── вложения в переписке ──────────────────────────────────────────────────────
test('скриншот из буфера получает имя с датой, картинка узнаётся по расширению', async () => {
  const { screenshotName, isAnonymousClipboardName, isImageName, isPlayableName, humanSize } = await load('lib/attachments.ts');

  assert.equal(screenshotName(new Date(2026, 8, 2, 14, 33, 7), 'image/png'), 'Снимок 2026-09-02 14-33-07.png');
  assert.equal(screenshotName(new Date(2026, 0, 5, 9, 4, 1), 'image/jpeg'), 'Снимок 2026-01-05 09-04-01.jpg');
  assert.equal(screenshotName(new Date(2026, 0, 5, 9, 4, 1), 'image/непонятно').endsWith('.png'), true);

  // переименовываем только безымянное из буфера
  assert.equal(isAnonymousClipboardName('image.png'), true);
  assert.equal(isAnonymousClipboardName(''), true);
  assert.equal(isAnonymousClipboardName(null), true);
  assert.equal(isAnonymousClipboardName('смета за август.pdf'), false);
  assert.equal(isAnonymousClipboardName('Снимок экрана 2026-09-01.png'), false, 'своё имя не трогаем');

  assert.equal(isImageName('a.PNG'), true);
  // клипы играют в ленте, документы скачиваются: webm двусмыслен, и голосовое
  // отличается говорящим именем — ошибиться в сторону видео безопаснее (оно со звуком)
  assert.equal(isPlayableName('Голосовое 03.09.2026.webm'), 'audio');
  assert.equal(isPlayableName('Запись экрана 03.09.2026.webm'), 'video');
  assert.equal(isPlayableName('отчёт.pdf'), null);
  assert.equal(isPlayableName('разговор.mp3'), 'audio');
  assert.equal(isPlayableName('демо.mp4'), 'video');
  assert.equal(isImageName('отчёт.pdf'), false);
  assert.equal(isImageName('без-расширения'), false);

  assert.equal(humanSize(900), '900 Б');
  assert.equal(humanSize(348 * 1024), '348 КБ');
  assert.equal(humanSize(3 * 1024 * 1024), '3.0 МБ');
});

// ── текст сообщения ───────────────────────────────────────────────────────────
test('разбор сообщения: упоминания, ссылки, склейка подряд идущих', async () => {
  const { splitMessage, dayLabel, sameGroup } = await load('lib/chat-text.ts');

  const kinds = (t) => splitMessage(t).map((p) => `${p.kind}:${p.value}`);
  assert.deepEqual(kinds('@Сергей Попович глянь'), ['mention:@Сергей Попович', 'text: глянь']);
  assert.deepEqual(kinds('@Сергей глянь'), ['mention:@Сергей', 'text: глянь'], 'вторым словом со строчной имя не продолжается');
  assert.deepEqual(kinds('см. https://teamsmrt.com/x.'), ['text:см. ', 'link:https://teamsmrt.com/x', 'text:.'],
    'точка в конце принадлежит фразе, а не адресу');
  assert.deepEqual(kinds('без ничего'), ['text:без ничего']);
  assert.deepEqual(kinds(''), []);
  assert.deepEqual(kinds('почта a@b.ru'), ['text:почта a@b.ru'], 'адрес почты упоминанием не считается');

  // Ссылку вставляют как придётся: со схемой, с www и просто доменом. Кликается всё.
  assert.deepEqual(kinds('открой teamsmrt.com/projects/130'), ['text:открой ', 'link:teamsmrt.com/projects/130']);
  assert.deepEqual(kinds('www.example.com'), ['link:www.example.com']);
  // ...но голый домен без пути ссылкой не считается — иначе ими станут «т.д.» и «5.5»
  assert.deepEqual(kinds('и т.д. в 5.5 раза'), ['text:и т.д. в 5.5 раза']);

  const { hrefOf } = await load('lib/chat-text.ts');
  assert.equal(hrefOf('https://a.ru/x'), 'https://a.ru/x');
  // без схемы href считается адресом ВНУТРИ приложения — дописываем протокол
  assert.equal(hrefOf('teamsmrt.com/x'), 'https://teamsmrt.com/x');

  const now = new Date(2026, 8, 2, 12, 0);
  assert.equal(dayLabel(new Date(2026, 8, 2, 9, 0).toISOString(), now), 'Сегодня');
  assert.equal(dayLabel(new Date(2026, 8, 1, 9, 0).toISOString(), now), 'Вчера');
  assert.equal(dayLabel(new Date(2026, 7, 20, 9, 0).toISOString(), now), '20 августа');

  const at = (h, m) => new Date(2026, 8, 2, h, m).toISOString();
  assert.equal(sameGroup({ author_id: 1, created_at: at(10, 0) }, { author_id: 1, created_at: at(10, 5) }), true);
  assert.equal(sameGroup({ author_id: 1, created_at: at(10, 0) }, { author_id: 1, created_at: at(10, 30) }), false, 'через полчаса — другой заход');
  assert.equal(sameGroup({ author_id: 1, created_at: at(10, 0) }, { author_id: 2, created_at: at(10, 1) }), false);
  assert.equal(sameGroup({ author_id: 1, is_ai: true, created_at: at(10, 0) }, { author_id: 1, created_at: at(10, 1) }), false,
    'ответ ИИ с сообщением человека не склеивается, даже если автор записан тот же');
  assert.equal(sameGroup(undefined, { author_id: 1, created_at: at(10, 0) }), false);
});

// ── упоминания в задаче ───────────────────────────────────────────────────────
test('подсказка «@» ставит вперёд участников задачи и подписывает их роли', async () => {
  const { orderMentions, roleOf } = await load('lib/task-mentions.ts');
  const team = [
    { id: 'ai', fullName: 'AI-помощник', hint: 'знает эту задачу' },
    { id: '1', fullName: 'Аня Посторонняя' },
    { id: '2', fullName: 'Борис Постановщик' },
    { id: '3', fullName: 'Витя Исполнитель' },
    { id: '4', fullName: 'Гриша Соисполнитель' },
    { id: '5', fullName: 'Дима Наблюдатель' },
  ];
  const people = {
    meId: '3', assigneeId: '3', creatorId: '2',
    participants: [{ user_id: '4', role: 'co_assignee' }, { user_id: '5', role: 'watcher' }],
  };

  // пишет ИСПОЛНИТЕЛЬ: помощник, постановщик, соисполнитель, наблюдатель, остальные
  assert.deepEqual(orderMentions(team, people).map((u) => u.id), ['ai', '2', '4', '5', '1']);
  assert.equal(orderMentions(team, people).some((u) => u.id === '3'), false, 'себя звать незачем');
  assert.deepEqual(
    orderMentions(team, people).map((u) => u.hint),
    ['знает эту задачу', 'Постановщик', 'Соисполнитель', 'Наблюдатель', undefined],
  );

  // пишет ПОСТАНОВЩИК: первым исполнитель
  const asCreator = { ...people, meId: '2' };
  assert.deepEqual(orderMentions(team, asCreator).map((u) => u.id), ['ai', '3', '4', '5', '1']);

  // человек со стороны: сначала исполнитель, потом постановщик
  const asOutsider = { ...people, meId: '1' };
  assert.deepEqual(orderMentions(team, asOutsider).map((u) => u.id), ['ai', '3', '2', '4', '5']);

  assert.equal(roleOf('3', people), 'assignee');
  assert.equal(roleOf('5', people), 'watcher');
  assert.equal(roleOf('1', people), null);

  // задача без исполнителя и без участников — список не должен разваливаться
  const bare = orderMentions(team, { meId: '1' });
  assert.deepEqual(bare.map((u) => u.id), ['ai', '2', '3', '4', '5']);
});

// ── напоминания о сообщениях ──────────────────────────────────────────────────
test('«напомнить мне»: вечер не предлагается ночью, подписи по-человечески', async () => {
  const { remindOptions, remindLabel } = await load('lib/remind-times.ts');

  const day = new Date(2026, 8, 3, 10, 0);   // утро рабочего дня
  const keys = remindOptions(day).map((o) => o.key);
  assert.deepEqual(keys, ['hour', 'evening', 'tomorrow', 'week']);

  // в 23:40 «сегодня вечером» означало бы «через двадцать минут» — вариант убираем
  const night = new Date(2026, 8, 3, 23, 40);
  assert.deepEqual(remindOptions(night).map((o) => o.key), ['hour', 'tomorrow', 'week']);
  const tomorrow = remindOptions(night).find((o) => o.key === 'tomorrow');
  assert.equal(tomorrow.at.getDate(), 4, 'завтра — это следующий день, а не сегодня');
  assert.equal(tomorrow.at.getHours(), 9);

  // все варианты строго в будущем: сервер прошедшее время не примет
  for (const o of remindOptions(day)) assert.equal(o.at.getTime() > day.getTime(), true, o.key);

  assert.equal(remindLabel(new Date(2026, 8, 3, 18, 0), day), 'сегодня в 18:00');
  assert.equal(remindLabel(new Date(2026, 8, 4, 9, 0), day), 'завтра в 09:00');
  assert.equal(remindLabel(new Date(2026, 8, 10, 9, 0), day), '10 сентября в 09:00');
});

// ── реестр задач ──────────────────────────────────────────────────────────────
test('реестр: пустые фильтры не уезжают в запрос, страницы не теряют края', async () => {
  const m = await load('lib/task-registry-view.ts');
  const { registryQuery, pageWindow, rangeLabel, activeFilterCount, endOfTodayIso, EMPTY_FILTERS } = m;

  const now = new Date(2026, 8, 3, 14, 30);

  // сервер отклоняет незнакомые и пустые значения (forbidNonWhitelisted):
  // «priority=» это не «без фильтра», а ответ 400
  const plain = registryQuery(EMPTY_FILTERS, now);
  assert.equal(plain.includes('priority='), false);
  assert.equal(plain.includes('projectId='), false);
  assert.equal(plain.includes('due='), false, 'срок «любой» — это отсутствие фильтра');
  assert.equal(plain.includes('sort='), false, 'сортировка по умолчанию не нужна в адресе');
  assert.equal(plain.includes('page='), false, 'первая страница — не параметр');
  // Без хвоста в адресе — все задачи компании: так решил заказчик (14.09).
  assert.equal(plain.includes('scope=all'), true, 'вход в раздел — все задачи, роли сужают');
  assert.equal(m.toScope(undefined), 'all', '/tasks без хвоста — все задачи');
  assert.equal(m.toScope('doing'), 'doing', 'у роли хвост свой');
  assert.equal(m.toScope('mine'), 'doing', 'старая ссылка живёт');
  assert.equal(plain.includes('dayEnd='), true, 'без границы суток «просрочено» считается по серверу');

  const full = registryQuery({
    ...EMPTY_FILTERS, scope: 'delegated', q: '  макет  ', projectId: '12',
    assigneeId: 'none', priority: 'high', due: 'overdue', sort: 'project', inWork: false, page: 3,
  }, now);
  const q = new URLSearchParams(full);
  assert.equal(q.get('scope'), 'delegated');
  assert.equal(q.get('q'), 'макет', 'поиск обрезается по краям');
  assert.equal(q.get('assigneeId'), 'none');
  assert.equal(q.get('closed'), '1', 'сняли «В работе» — просим у сервера всё, включая архив');
  assert.equal(q.get('page'), '3');

  // граница суток — конец дня у ЧЕЛОВЕКА, а не «сейчас»
  const end = new Date(endOfTodayIso(now));
  assert.equal(end.getHours(), 23);
  assert.equal(end.getDate(), 3);

  assert.equal(activeFilterCount(EMPTY_FILTERS), 0, 'срез фильтром не считается');
  assert.equal(activeFilterCount({ ...EMPTY_FILTERS, q: 'a', inWork: false, due: 'week' }), 3);

  // окно страниц: края доступны всегда, разрыв обозначен нулём
  assert.deepEqual(pageWindow(1, 1), [1]);
  assert.deepEqual(pageWindow(1, 3), [1, 2, 3]);
  assert.deepEqual(pageWindow(5, 9), [1, 0, 4, 5, 6, 0, 9]);
  assert.deepEqual(pageWindow(2, 9), [1, 2, 3, 0, 9], 'рядом с началом разрыв не нужен');
  assert.deepEqual(pageWindow(9, 9), [1, 0, 8, 9]);

  assert.equal(rangeLabel(1, 50, 137), '1–50 из 137');
  assert.equal(rangeLabel(3, 50, 137), '101–137 из 137', 'последняя страница не врёт про 150');
  assert.equal(rangeLabel(1, 50, 0), 'ничего не найдено');
});

// ── напоминания секретаря ─────────────────────────────────────────────────────
test('напоминания: группы без пустых, превью не из сводки, красным — только горящее', async () => {
  const { groupPings, pingPreview, urgentPings } = await load('lib/pings-view.ts');

  const items = [
    { id: '1', kind: 'due_soon', text: 'Срок через 1 день: «Задача на Сергея»' },
    { id: '2', kind: 'digest', text: 'Сводка дня:\n• одно\n• два' },
    { id: '3', kind: 'overdue', text: 'Срок прошёл 12 ч назад: «Голосовой поиск»' },
    { id: '4', kind: 'stuck_review', text: 'Висит на проверке третий день' },
  ];

  const groups = groupPings(items);
  assert.deepEqual(groups.map((g) => g.title), ['Сводка', 'Просрочено', 'Зависло на проверке', 'Скоро срок']);
  for (const g of groups) assert.equal(g.items.length > 0, true, `пустая группа ${g.title}`);

  // новый вид с сервера не должен пропадать с экрана молча
  const withNew = groupPings([...items, { id: '5', kind: 'whatever_new', text: 'Новый повод' }]);
  assert.equal(withNew[withNew.length - 1].title, 'Прочее');
  assert.equal(withNew[withNew.length - 1].items[0].id, '5');

  // сводка многострочная: в одну строку от неё остаётся обрывок — берём дело
  assert.equal(pingPreview(items).startsWith('Срок через 1 день'), true);
  // если кроме сводки ничего нет, показываем её, схлопнув переносы
  assert.equal(pingPreview([items[1]]).includes('\n'), false);
  // длинный текст обрезается с многоточием, а не рвёт строку
  const long = pingPreview([{ id: '9', kind: 'overdue', text: 'я'.repeat(300) }], 20);
  assert.equal(long.length, 20);
  assert.equal(long.endsWith('…'), true);

  // красным горит просроченное и зависшее, сводка и «скоро срок» — нет
  assert.equal(urgentPings(items), 2);
  assert.equal(urgentPings([items[1], items[0]]), 0);
  assert.equal(pingPreview([]), '', 'пустой список не роняет строку');
});

// ── мигание вкладки ───────────────────────────────────────────────────────────
test('вкладка мигает только о новом и называет самое весомое', async () => {
  const { tabAlertMessage } = await load('lib/tab-alert.ts');

  // первый замер молчит: иначе вкладка мигала бы при каждом открытии приложения
  assert.equal(tabAlertMessage(null, { tasks: 3, chats: 5 }), null);

  const was = { tasks: 1, news: 0, calendar: 0, decide: 0, chats: 2 };
  assert.equal(tabAlertMessage(was, { ...was, tasks: 2 }), 'Новое в задачах');
  assert.equal(tabAlertMessage(was, { ...was, chats: 3 }), 'Новое сообщение');
  assert.equal(tabAlertMessage(was, { ...was, news: 1 }), 'Новое объявление');
  assert.equal(tabAlertMessage(was, { ...was, calendar: 1 }), 'Приглашение на встречу');

  // выросло два счётчика сразу — называем то, что требует действия
  assert.equal(tabAlertMessage(was, { ...was, tasks: 2, chats: 9 }), 'Новое в задачах');
  assert.equal(tabAlertMessage(was, { ...was, decide: 1, news: 1 }), 'Ждёт вашего решения');

  // разобрал накопившееся — это не повод мигать
  assert.equal(tabAlertMessage(was, { ...was, tasks: 0, chats: 0 }), null);
  assert.equal(tabAlertMessage(was, was), null);
});

// ── запуск ────────────────────────────────────────────────────────────────────
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

let failed = 0;
for (const [name, fn] of cases) {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ПРОВАЛ ${name}`);
    console.log(`         ${e.message.split('\n')[0]}`);
  }
}

console.log(`\nлогика: проверок ${cases.length}, провалов ${failed}`);
process.exit(failed ? 1 : 0);
