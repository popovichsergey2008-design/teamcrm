/**
 * У pdf-parse нет типов, а @types/pdf-parse описывает только корневой модуль.
 * Импортируем точечно (в index.js пакета есть отладочная ветка, читающая файл с диска),
 * поэтому объявляем ровно то, чем пользуемся.
 */
declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info?: Record<string, unknown>;
  }
  function pdfParse(data: Buffer): Promise<PdfParseResult>;
  export default pdfParse;
}
