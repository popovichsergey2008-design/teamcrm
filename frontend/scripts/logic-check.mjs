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
    ['/focus/calendar', { section: 'focus', view: 'calendar' }],
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
