/**
 * Текст документа по ссылке (#4968): паспорт проекта в Инфоцентре — ссылка на Word,
 * Excel, PDF на Яндекс Диске, в OneDrive или прямым адресом. Нейроагент должен знать
 * СОДЕРЖИМОЕ документа, а не только его название, — поэтому скачиваем и разбираем
 * тем же разборщиком, что и вложения (file-text.ts).
 *
 * Google-документы читаются отдельно (gdocs.util, экспорт в текст) — здесь всё остальное.
 * Запросы — только через safeFetch: ссылку дал человек, а ходит наш сервер.
 */
import JSZip from 'jszip';
import { htmlToText, safeFetch } from '../../common/net/safe-fetch';
import { extractText, MAX_FILE_BYTES, MAX_TEXT_CHARS } from './file-text';

export type DocLinkResult = { ok: true; text: string } | { ok: false; reason: string };

const ANY = /.*/;
const host = (u: URL) => u.hostname.replace(/^www\./, '').toLowerCase();

/** Ссылка похожа на документ, а не на сайт: файл по расширению или файловое хранилище. */
export function isDocLink(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  const h = host(u);
  if (/^(disk\.yandex\.(ru|com|kz|by)|yadi\.sk|disk\.360\.yandex\.ru)$/.test(h)) return true;
  if (/^(1drv\.ms|onedrive\.live\.com)$/.test(h) || h.endsWith('.sharepoint.com')) return true;
  return /\.(docx|xlsx|pdf|txt|md|csv)$/i.test(u.pathname);
}

/** Тип файла по содержимому: у хранилищ имя и тип в ответе часто «application/octet-stream». */
async function sniffName(buf: Buffer, fallback: string): Promise<string> {
  if (/\.(docx|xlsx|pdf|txt|md|csv)$/i.test(fallback)) return fallback;
  if (buf.subarray(0, 4).toString('latin1') === '%PDF') return 'doc.pdf';
  if (buf.subarray(0, 2).toString('latin1') === 'PK') {
    try {
      const zip = await JSZip.loadAsync(buf);
      if (zip.file('word/document.xml')) return 'doc.docx';
      if (zip.file('xl/sharedStrings.xml') || zip.file('xl/workbook.xml')) return 'doc.xlsx';
    } catch { /* не zip — разберём как страницу */ }
  }
  return fallback;
}

async function fromBytes(buf: Buffer | undefined, name: string, contentType: string): Promise<DocLinkResult> {
  if (!buf?.length) return { ok: false, reason: 'пустой ответ' };
  const file = await sniffName(buf, name);
  const got = await extractText(buf, file, contentType);
  if (got) return { ok: true, text: got.text };
  if (/text\/html|xhtml/i.test(contentType)) {
    const page = htmlToText(buf.toString('utf8'));
    // страница входа вместо документа — доступа по ссылке нет
    if (/войти|войдите|sign in|log in|запросить доступ|request access/i.test(page.text.slice(0, 600)) && page.text.length < 3000) {
      return { ok: false, reason: 'нет доступа по ссылке' };
    }
    const text = page.text.trim();
    return text.length > 20 ? { ok: true, text: text.slice(0, MAX_TEXT_CHARS) } : { ok: false, reason: 'пустая страница' };
  }
  return { ok: false, reason: 'формат не читается' };
}

/** Яндекс Диск: публичная ссылка → прямой адрес файла через открытый API Диска. */
async function yandexDisk(raw: string): Promise<DocLinkResult> {
  const meta = await safeFetch(
    `https://cloud-api.yandex.net/v1/disk/public/resources?public_key=${encodeURIComponent(raw)}&fields=name,file,type,size`,
    { types: /json/i, timeoutMs: 15_000 },
  );
  if (meta.status !== 200) return { ok: false, reason: 'нет доступа по ссылке' };
  const m = JSON.parse(meta.body) as { name?: string; file?: string; type?: string; size?: number };
  if (m.type === 'dir' || !m.file) return { ok: false, reason: 'это папка, а не файл' };
  if ((m.size ?? 0) > MAX_FILE_BYTES) return { ok: false, reason: 'файл больше 15 МБ' };
  const f = await safeFetch(m.file, { raw: true, types: ANY, maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000, maxRedirects: 5 });
  return fromBytes(f.raw, m.name ?? '', f.contentType);
}

/** OneDrive / SharePoint: ссылка «для всех» скачивается через shares API. */
async function oneDrive(raw: string): Promise<DocLinkResult> {
  const id = 'u!' + Buffer.from(raw).toString('base64').replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  const f = await safeFetch(`https://api.onedrive.com/v1.0/shares/${id}/root/content`, {
    raw: true, types: ANY, maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000, maxRedirects: 5,
  });
  if (f.status !== 200) return { ok: false, reason: 'нет доступа по ссылке' };
  return fromBytes(f.raw, '', f.contentType);
}

/** Текст документа по ссылке или причина, почему прочитать нельзя. Не бросает. */
export async function fetchDocLinkText(raw: string): Promise<DocLinkResult> {
  try {
    const u = new URL(raw);
    const h = host(u);
    if (/^(disk\.yandex\.(ru|com|kz|by)|yadi\.sk|disk\.360\.yandex\.ru)$/.test(h)) return await yandexDisk(raw);
    if (/^(1drv\.ms|onedrive\.live\.com)$/.test(h) || h.endsWith('.sharepoint.com')) return await oneDrive(raw);
    const f = await safeFetch(raw, { raw: true, types: ANY, maxBytes: MAX_FILE_BYTES, timeoutMs: 30_000, maxRedirects: 5 });
    if (f.status !== 200) return { ok: false, reason: `сайт ответил ${f.status}` };
    const name = decodeURIComponent(u.pathname.split('/').pop() ?? '');
    return await fromBytes(f.raw, name, f.contentType);
  } catch (e) {
    return { ok: false, reason: (e as Error).message.slice(0, 120) };
  }
}
