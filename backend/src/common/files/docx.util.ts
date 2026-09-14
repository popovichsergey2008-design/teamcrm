import { Document, HeadingLevel, Packer, Paragraph, TextRun } from 'docx';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/**
 * Текст → .docx.
 *
 * Один сборщик на всех, кто отдаёт человеку готовый документ (ИИ-агент, AnthillBot):
 * две копии разошлись бы на первой же правке оформления, а человек получал бы
 * из разных мест по-разному сверстанные файлы.
 *
 * Шрифт не задаём намеренно: Word подставит свой, и кириллица не превратится в
 * квадраты на машине, где нашего шрифта нет.
 */
export async function buildDocx(title: string, body: string): Promise<Buffer> {
  const paragraphs = [
    new Paragraph({ text: title, heading: HeadingLevel.HEADING_1 }),
    ...body.split('\n').map((line) => new Paragraph({ children: [new TextRun(line)] })),
  ];
  const doc = new Document({ creator: 'TeamCRM', sections: [{ children: paragraphs }] });
  return Packer.toBuffer(doc);
}
