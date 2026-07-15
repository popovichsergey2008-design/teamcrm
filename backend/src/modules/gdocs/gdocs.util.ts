/**
 * Утилиты для Google-доков, на которые ссылаются задачи/комментарии.
 * Читаем ТОЛЬКО документы, открытые «по ссылке» — через публичный export-endpoint (без OAuth).
 */

export type GDocType = 'document' | 'spreadsheet' | 'presentation' | 'file';
export interface GLink { docKey: string; docType: GDocType; url: string; }

const MAX_TEXT = 200_000; // ограничение на объём вытянутого текста

/** Находит ссылки на Google Docs/Sheets/Slides/Drive в тексте. Дедуплицирует по (тип+ключ). */
export function extractGoogleLinks(text: string | null | undefined): GLink[] {
  if (!text) return [];
  const out: GLink[] = [];
  const seen = new Set<string>();
  const re = /https?:\/\/(?:docs|drive)\.google\.com\/(document|spreadsheets|presentation|file)\/d\/([a-zA-Z0-9_-]{10,})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(String(text))) !== null) {
    const kind = m[1].toLowerCase();
    const docType: GDocType = kind === 'spreadsheets' ? 'spreadsheet' : (kind as GDocType);
    const docKey = m[2];
    const key = `${docType}:${docKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ docKey, docType, url: m[0] });
  }
  return out;
}

/** URL публичного экспорта в текст/csv. Для произвольных Drive-файлов текстового экспорта нет. */
function exportUrl(docType: GDocType, docKey: string): string | null {
  if (docType === 'document') return `https://docs.google.com/document/d/${docKey}/export?format=txt`;
  if (docType === 'spreadsheet') return `https://docs.google.com/spreadsheets/d/${docKey}/export?format=csv`;
  if (docType === 'presentation') return `https://docs.google.com/presentation/d/${docKey}/export/txt`;
  return null; // file/d — произвольный файл (pdf/docx), текстового экспорта нет
}

export interface FetchResult {
  ok: boolean;
  text?: string;
  reason?: 'unsupported' | 'no_access' | 'error';
  detail?: string;
}

/** Тянет текст открытого «по ссылке» дока. Приватные → no_access, не-Google-файлы → unsupported. */
export async function fetchGoogleDocText(docType: GDocType, docKey: string): Promise<FetchResult> {
  const url = exportUrl(docType, docKey);
  if (!url) return { ok: false, reason: 'unsupported', detail: 'Произвольный файл Google Drive — текстовый экспорт недоступен' };
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(25000) });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const body = await res.text();
    // приватный док → Google отдаёт HTML-страницу входа
    const looksLikeLogin = ct.includes('text/html') || /accounts\.google\.com|ServiceLogin|Sign in|Войдите|Request access|Запросить доступ/i.test(body.slice(0, 800));
    if (!res.ok || looksLikeLogin) return { ok: false, reason: 'no_access', detail: `HTTP ${res.status}` };
    const text = body.slice(0, MAX_TEXT).trim();
    if (!text) return { ok: false, reason: 'no_access', detail: 'пусто' };
    return { ok: true, text };
  } catch (e) {
    return { ok: false, reason: 'error', detail: (e as Error).message };
  }
}
