#!/usr/bin/env node
/**
 * Проверка видимого фокуса: до чего можно дотабать, то должно быть видно.
 *
 * Зачем: человек, работающий с клавиатуры, без кольца фокуса перемещается вслепую —
 * жмёт Enter наугад. Глазами это не ловится, потому что мышью кольцо не появляется
 * вовсе (`:focus-visible`), и разработчик его просто не видит.
 *
 * Как считаем: кликабельным считаем класс, у которого в CSS есть `cursor: pointer`;
 * ругаемся, если такой класс используется в разметке, но кольца у него нет.
 * Это эвристика, а не истина: класс без `cursor: pointer` сюда не попадёт. Зато она
 * не требует браузера и ловит ровно тот случай, который мы уже находили руками —
 * два десятка мест без кольца.
 *
 * Запуск: npm run a11y (в CI — рядом с проверкой контраста).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const css = ['app.css', 'index.css'].map((f) => readFileSync(join(SRC, f), 'utf8')).join('\n');

// классы с cursor: pointer — то, что задумано кликабельным
const clickable = new Set();
for (const rule of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
  if (!/cursor:\s*pointer/.test(rule[2])) continue;
  for (const cls of rule[1].matchAll(/\.([a-z0-9-]+)/gi)) clickable.add(cls[1]);
}

// классы, у которых есть :focus-visible — свой или в группе селекторов
const focusable = new Set();
for (const rule of css.matchAll(/([^{}]+):focus-visible/g)) {
  for (const cls of rule[1].matchAll(/\.([a-z0-9-]+)/gi)) focusable.add(cls[1]);
}

// какие классы реально встречаются в разметке
const used = new Set();
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith('.tsx')) {
      const src = readFileSync(p, 'utf8');
      for (const m of src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)) {
        for (const token of (m[1] ?? m[2]).split(/[\s${}?:'"()]+/)) if (token) used.add(token);
      }
    }
  }
};
walk(SRC);

const gaps = [...clickable].filter((c) => used.has(c) && !focusable.has(c)).sort();
console.log(`фокус: кликабельных классов ${clickable.size}, с кольцом ${focusable.size}`);

if (!gaps.length) {
  console.log('без кольца фокуса: нет');
} else {
  console.log('БЕЗ КОЛЬЦА ФОКУСА:');
  for (const g of gaps) console.log('  .' + g);
  console.log('');
  console.log('Добавьте правило :focus-visible с outline — либо уберите cursor: pointer,');
  console.log('если элемент на самом деле не кликается.');
  process.exit(1);
}
