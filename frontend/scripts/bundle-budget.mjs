#!/usr/bin/env node
/**
 * Порог веса сборки (ТЗ-15, §43 и §87 плана): сборка падает, если первый экран потяжелел.
 *
 * Зачем: вес растёт по килобайту за раз, и ни одна правка по отдельности не выглядит
 * виноватой. До разбиения по разделам главный кусок весил 375 КБ в сжатом виде, после —
 * 278 КБ. Порог держим с запасом около 5%: превысили — либо убираем лишнее, либо
 * осознанно поднимаем число здесь, с причиной в сообщении коммита.
 *
 * Считаем gzip -9, как отдаёт сервер (gzip_static), только главный JS и CSS: остальные
 * куски грузятся по требованию и первый экран не задерживают.
 *
 * Запуск: npm run budget (после npm run build).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

const DIST = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'assets');
const BUDGET_KB = { js: 282, css: 43 };

const files = readdirSync(DIST);
const main = (ext) => {
  const name = files.find((f) => f.startsWith('index-') && f.endsWith(`.${ext}`));
  if (!name) throw new Error(`нет главного .${ext} в ${DIST} — сначала npm run build`);
  return { name, kb: gzipSync(readFileSync(join(DIST, name)), { level: 9 }).length / 1024 };
};

let failed = false;
for (const ext of ['js', 'css']) {
  const { name, kb } = main(ext);
  const limit = BUDGET_KB[ext];
  const ok = kb <= limit;
  failed ||= !ok;
  console.log(`${ok ? 'ok  ' : 'МНОГО'} ${ext.padEnd(3)} ${kb.toFixed(1).padStart(6)} КБ из ${limit} КБ  ${name}`);
}
if (failed) {
  console.log('\nПервый экран потяжелел сверх порога. Вынесите редкое в lazy(), уберите лишний импорт');
  console.log('или — если рост оправдан — поднимите BUDGET_KB в scripts/bundle-budget.mjs и объясните в коммите.');
  process.exit(1);
}
