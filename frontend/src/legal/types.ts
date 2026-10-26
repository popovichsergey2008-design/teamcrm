/**
 * Документ политики (#4675) — блоки в порядке документа, текст дословный.
 *
 * Внутри строк: `**жирное**` и `[[privacy|текст]]` / `[[remote-support|текст]]` —
 * ссылка на другой наш документ. Ничего другого разметкой не считается.
 */
export type LegalBlock =
  | { h: string }
  | { p: string }
  | { ul: string[] }
  | { ol: string[] }
  | { table: { head: string[]; rows: string[][] } };

export interface LegalDocument {
  title: string;
  /** Строка редакции — как в документе («Редакция от 26 октября 2026 г.»). */
  edition: string;
  blocks: LegalBlock[];
}
