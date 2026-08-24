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
    ['/projects', { section: 'projects' }],
    ['/projects/clients', { section: 'projects', view: 'clients' }],
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
