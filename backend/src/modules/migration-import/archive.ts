import JSZip from 'jszip';
import { ImportBundle, ImportSource } from './import-types';
import { readSlackExport } from './slack-parse';
import { readTelegramExport } from './telegram-parse';

/**
 * Открыть загруженный архив и привести к общему виду.
 *
 * Источник человек выбирает карточкой, но архив проверяем по содержимому: перепутать
 * карточки легко, и «это не экспорт Slack» понятнее, чем пустой отчёт.
 */
export interface OpenedArchive {
  bundle: ImportBundle;
  /** Архив — для чтения медиа Telegram при переносе; у одиночного result.json его нет. */
  zip: JSZip | null;
}

export function looksLikeZip(buf: Buffer): boolean {
  return buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b; // «PK»
}

export async function openArchive(source: ImportSource, buf: Buffer): Promise<OpenedArchive> {
  if (source === 'slack') {
    if (!looksLikeZip(buf)) throw new Error('Нужен архив .zip, который Slack присылает после экспорта');
    const zip = await loadZip(buf);
    return { bundle: await readSlackExport(zip), zip };
  }

  if (!looksLikeZip(buf)) {
    // загрузили сам result.json — переписку переносим, файлы честно попадут в отчёт
    return { bundle: readTelegramExport(parseJson(buf.toString('utf8')), '', false), zip: null };
  }
  const zip = await loadZip(buf);
  const candidates = Object.keys(zip.files).filter((p) => !zip.files[p].dir && /(^|\/)result\.json$/.test(p));
  if (!candidates.length) {
    throw new Error('В архиве нет result.json. В Telegram Desktop выберите формат «JSON» при экспорте');
  }
  const path = candidates.sort((a, b) => a.length - b.length)[0];
  const base = path.slice(0, path.lastIndexOf('/') + 1);
  const json = parseJson(await zip.file(path)!.async('string'));
  return { bundle: readTelegramExport(json, base, true), zip };
}

async function loadZip(buf: Buffer): Promise<JSZip> {
  try {
    return await JSZip.loadAsync(buf);
  } catch {
    throw new Error('Архив не открывается — возможно, он загрузился не полностью. Попробуйте ещё раз');
  }
}

function parseJson(text: string): unknown {
  try {
    // Telegram Desktop пишет файл с BOM в некоторых версиях
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('result.json не читается. В Telegram Desktop выберите формат «JSON», а не HTML');
  }
}
