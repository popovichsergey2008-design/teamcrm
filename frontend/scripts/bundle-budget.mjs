#!/usr/bin/env node
/**
 * Порог веса первого экрана (ТЗ-15, §43 и §87 плана): сборка падает, если он потяжелел.
 *
 * Зачем: вес растёт по килобайту за раз, и ни одна правка по отдельности не выглядит
 * виноватой. До разбиения по разделам всё приложение приезжало одним куском — 375 КБ
 * в сжатом виде.
 *
 * Считаем ВСЁ, что index.html грузит сразу: точку входа и куски из modulepreload.
 * Сначала здесь мерился только index-*.js — и цифра «упала» до 150 КБ, когда сборщик
 * вынес общие компоненты в отдельный кусок, хотя грузился он по-прежнему сразу. Такой
 * порог врёт в обе стороны, поэтому меряем то, что действительно едет до первого экрана.
 *
 * gzip -9, как отдаёт сервер (gzip_static). Порог — с запасом около 5%: превысили —
 * либо убираем лишнее (lazy, лишний импорт), либо осознанно поднимаем число здесь,
 * с причиной в сообщении коммита.
 *
 * Запуск: npm run budget (после npm run build).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const BUDGET_KB = { js: 292, css: 46 };

const html = readFileSync(join(DIST, 'index.html'), 'utf8');
const files = [...new Set([...html.matchAll(/(?:src|href)="\/(assets\/[^"]+\.(?:js|css))"/g)].map((m) => m[1]))];
if (!files.length) throw new Error('в dist/index.html нет ни одного файла из assets — сначала npm run build');

const kb = (f) => gzipSync(readFileSync(join(DIST, f)), { level: 9 }).length / 1024;
const sum = { js: 0, css: 0 };
const rows = files.map((f) => {
  const ext = f.endsWith('.css') ? 'css' : 'js';
  const size = kb(f);
  sum[ext] += size;
  return { f, size };
}).sort((a, b) => b.size - a.size);

let failed = false;
for (const ext of ['js', 'css']) {
  const ok = sum[ext] <= BUDGET_KB[ext];
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'МНОГО'} ${ext.padEnd(3)} ${sum[ext].toFixed(1).padStart(6)} КБ из ${BUDGET_KB[ext]} КБ`);
}
console.log('самые тяжёлые куски первого экрана:');
for (const r of rows.slice(0, 5)) console.log(`  ${r.size.toFixed(1).padStart(6)} КБ  ${r.f}`);
if (failed) {
  console.log('\nПервый экран потяжелел сверх порога. Вынесите редкое в lazy(), уберите лишний импорт');
  console.log('или — если рост оправдан — поднимите BUDGET_KB в scripts/bundle-budget.mjs и объясните в коммите.');
  process.exit(1);
}
