import JSZip from 'jszip';
import { detectKind, extractText, xmlToText, MAX_FILE_BYTES } from './file-text';

/**
 * Разбор вложений проверяем на настоящих файлах, а не на моках: смысл шага в том,
 * чтобы «найди по номеру договора» находило текст ВНУТРИ документа, и подделка
 * парсера доказывала бы только работу подделки.
 */
describe('текст из вложений', () => {
  it('узнаёт формат и по расширению, и по типу содержимого', () => {
    expect(detectKind('договор.pdf')).toBe('pdf');
    expect(detectKind('без-расширения', 'application/pdf')).toBe('pdf');
    expect(detectKind('акт.docx')).toBe('docx');
    expect(detectKind('смета.xlsx')).toBe('xlsx');
    expect(detectKind('заметка.md')).toBe('plain');
    expect(detectKind('данные', 'text/plain')).toBe('plain');
    // картинки и архивы не поддерживаем — и не притворяемся
    expect(detectKind('скан.png', 'image/png')).toBeNull();
    expect(detectKind('архив.zip')).toBeNull();
  });

  it('вынимает текст из XML, схлопывая теги и сущности', () => {
    const xml = '<w:p><w:r><w:t>Договор</w:t></w:r><w:r><w:t> №&#39;415&#39;</w:t></w:r></w:p><w:p><w:t>ИНН 7701234567</w:t></w:p>';
    expect(xmlToText(xml)).toBe("Договор №'415'\nИНН 7701234567");
  });

  it('читает настоящий docx', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml',
      '<?xml version="1.0"?><w:document><w:body><w:p><w:r><w:t>Гарантия 24 месяца</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>ИНН 7701234567</w:t></w:r></w:p></w:body></w:document>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await extractText(buf, 'условия.docx', '');
    expect(res?.kind).toBe('docx');
    expect(res?.text).toContain('Гарантия 24 месяца');
    expect(res?.text).toContain('7701234567');
  });

  it('читает текст ячеек из настоящего xlsx', async () => {
    const zip = new JSZip();
    zip.file('xl/sharedStrings.xml',
      '<?xml version="1.0"?><sst><si><t>Счёт 415-А</t></si><si><t>Оплачено</t></si></sst>');
    const buf = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await extractText(buf, 'счета.xlsx', '');
    expect(res?.text).toContain('Счёт 415-А');
    expect(res?.text).toContain('Оплачено');
  });

  it('простой текст читается как есть', async () => {
    const res = await extractText(Buffer.from('Договор №415 от 12.03', 'utf8'), 'note.txt', 'text/plain');
    expect(res?.kind).toBe('plain');
    expect(res?.text).toBe('Договор №415 от 12.03');
  });

  it('битый файл не роняет индексацию, а просто не даёт текста', async () => {
    expect(await extractText(Buffer.from('это не docx'), 'битый.docx', '')).toBeNull();
    expect(await extractText(Buffer.from('%PDF-1.4 мусор'), 'битый.pdf', '')).toBeNull();
  });

  it('пустое и слишком большое не индексируем', async () => {
    expect(await extractText(Buffer.from('  '), 'пусто.txt', 'text/plain')).toBeNull();
    const huge = Buffer.alloc(MAX_FILE_BYTES + 1);
    expect(await extractText(huge, 'огромный.txt', 'text/plain')).toBeNull();
  });

  it('длинный текст обрезается, а не уходит в эмбеддинги целиком', async () => {
    const long = 'а'.repeat(300_000);
    const res = await extractText(Buffer.from(long, 'utf8'), 'много.txt', 'text/plain');
    expect(res!.text.length).toBe(200_000);
  });
});
