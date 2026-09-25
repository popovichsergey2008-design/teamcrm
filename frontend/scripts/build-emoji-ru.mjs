#!/usr/bin/env node
/**
 * Русские названия эмодзи — в компактный файл, который уезжает в сборку.
 *
 * Зачем. Палитра берёт полный набор Unicode из emoji-mart, но искать в нём можно
 * только по-английски: «fire», «check mark». В рабочей переписке так никто не ищет —
 * набирают «огонь» и «готово». Русские названия есть в emojibase, но тащить его в
 * зависимости ради одного словаря дорого: пакет весит двадцать шесть мегабайт.
 *
 * Поэтому словарь собирается ОДИН РАЗ этим скриптом и коммитится готовым файлом:
 * в сборке остаётся ~80 КБ текста, а лишней зависимости нет вовсе.
 *
 * Запуск (после `npm i --no-save emojibase-data`):
 *   node scripts/build-emoji-ru.mjs
 */
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const data = require('emojibase-data/ru/compact.json');

/** Знак без «вариационных селекторов»: в разных наборах они стоят по-разному. */
const key = (unicode) => String(unicode).replace(/[\uFE0E\uFE0F]/g, '');

const out = {};
for (const item of data) {
  const words = [item.label, ...(item.tags ?? [])]
    .filter(Boolean)
    .map((w) => String(w).toLowerCase().trim())
    .filter((w) => w && !/^[a-z0-9 _-]+$/.test(w)); // латиница и так ищется штатно
  if (!words.length) continue;
  out[key(item.unicode)] = [...new Set(words)].join(' ');
}

const path = join(ROOT, 'src', 'lib', 'emoji-ru.json');
writeFileSync(path, JSON.stringify(out), 'utf8');
console.log(`русских названий: ${Object.keys(out).length}, файл ${path}`);
