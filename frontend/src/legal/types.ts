/** Пункт списка: строка или строка с вложенным нумерованным списком. */
export type LegalItem = string | { text: string; ordered: string[] };

export interface LegalSection {
  heading: string;
  items?: LegalItem[];
  /** Абзац без списка — для «Главное в одной фразе». */
  text?: string;
}

export interface LegalDocument {
  title: string;
  /** Подзаголовок в скобках у названия, если есть («Онлайн-помощь»). */
  subtitle?: string;
  /** Строки шапки под названием: оператор, сервис. */
  lead: string[];
  sections: LegalSection[];
}
