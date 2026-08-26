#!/usr/bin/env node
/**
 * Растровые иконки приложения из того же знака, что и favicon.svg.
 *
 * Зачем скрипт, а не готовые картинки: знак должен пересобираться, когда меняется
 * фирменный цвет или сама фигура, — иначе рано или поздно в репозитории окажется
 * иконка от старого логотипа, и никто не вспомнит, чем её рисовали.
 *
 * Зачем вообще растр, если есть SVG: iOS не умеет SVG в «добавить на главный экран»
 * и в манифесте — а телефон здесь один из основных сценариев (гостевые созвоны,
 * уведомления). Без png на домашнем экране будет серый прямоугольник со скриншотом.
 *
 * Без зависимостей: фигуры простые, а рисование с четырёхкратным сглаживанием
 * и упаковка png через zlib занимают меньше места, чем любая графическая библиотека.
 *
 * Запуск: npm run icons
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/** Те же координаты, что в favicon.svg, в системе 32×32. */
const ART = {
  radius: 7,
  from: [0x2a, 0x67, 0xff],
  to: [0x1e, 0x57, 0xe6],
  shapes: [
    { x: 7, y: 9, w: 12, h: 3.6, r: 1.4, alpha: 1 },      // перекладина
    { x: 11.2, y: 9, w: 3.6, h: 14, r: 1.4, alpha: 1 },   // ножка
    { x: 21.4, y: 9, w: 3.6, h: 3.6, r: 1.4, alpha: 0.85 }, // оторванный конец
  ],
};

/** Точка внутри прямоугольника со скруглёнными углами. */
function insideRounded(px, py, { x, y, w, h, r }) {
  if (px < x || py < y || px > x + w || py > y + h) return false;
  const cx = Math.min(Math.max(px, x + r), x + w - r);
  const cy = Math.min(Math.max(py, y + r), y + h - r);
  const dx = px - cx;
  const dy = py - cy;
  return dx * dx + dy * dy <= r * r;
}

function render(size) {
  const scale = size / 32;
  const ss = 4; // четыре подпикселя по каждой оси — краям хватает, чтобы не быть лесенкой
  const data = Buffer.alloc(size * size * 4);

  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let bgHits = 0;
      let fgHits = 0;
      let fgAlpha = 0;

      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const ux = (px + (sx + 0.5) / ss) / scale; // координаты в системе 32×32
          const uy = (py + (sy + 0.5) / ss) / scale;

          if (!insideRounded(ux, uy, { x: 0, y: 0, w: 32, h: 32, r: ART.radius })) continue;
          bgHits++;

          for (const s of ART.shapes) {
            if (insideRounded(ux, uy, s)) {
              fgHits++;
              fgAlpha += s.alpha;
              break;
            }
          }
        }
      }

      const total = ss * ss;
      const coverage = bgHits / total;
      const i = (py * size + px) * 4;
      if (coverage === 0) continue; // за скруглением — прозрачно

      // фон: диагональный градиент, как в svg
      const t = (px + py) / (2 * size);
      const bg = ART.from.map((c, k) => Math.round(c + (ART.to[k] - c) * t));

      // белая фигура поверх, с учётом её собственной прозрачности
      const white = fgHits ? fgAlpha / fgHits : 0;
      const mix = fgHits / total;
      const r = Math.round(bg[0] + (255 - bg[0]) * mix * white);
      const g = Math.round(bg[1] + (255 - bg[1]) * mix * white);
      const b = Math.round(bg[2] + (255 - bg[2]) * mix * white);

      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = Math.round(coverage * 255);
    }
  }
  return data;
}

// ── упаковка png ──────────────────────────────────────────────────────────────

const CRC = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return (buf) => {
    let c = -1;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
  };
})();

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(typed));
  return Buffer.concat([len, typed, crc]);
}

function png(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // бит на канал
  ihdr[9] = 6;  // RGBA
  // строки с фильтром 0: картинка маленькая, экономить байты незачем
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT, { recursive: true });
// 32 — для вкладки браузера там, где svg не поддерживается; остальные — телефон и манифест
for (const [name, size] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) {
  writeFileSync(join(OUT, name), png(size, render(size)));
  console.log(`  ${name} — ${size}×${size}`);
}
console.log('иконки собраны из знака favicon.svg');
