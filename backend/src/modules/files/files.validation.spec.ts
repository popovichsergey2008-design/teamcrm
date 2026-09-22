import { decodeUploadName, MAX_FILE_BYTES, sanitizeFileName, validateUpload } from './files.validation';

describe('validateUpload', () => {
  it('пропускает разрешённый тип в пределах размера', () => {
    expect(validateUpload('image/png', 1000).ok).toBe(true);
    expect(validateUpload('application/pdf', 1000).ok).toBe(true);
  });
  it('отклоняет неразрешённый тип (exe)', () => {
    const r = validateUpload('application/x-msdownload', 1000);
    expect(r.ok).toBe(false);
  });
  it('отклоняет превышение размера', () => {
    expect(validateUpload('image/png', MAX_FILE_BYTES + 1).ok).toBe(false);
  });
  it('отклоняет пустой файл', () => {
    expect(validateUpload('image/png', 0).ok).toBe(false);
  });
  it('пропускает архивы и незнакомые типы: они идут вложением, а не открываются', () => {
    // задача #1361: один такой файл рядом со снимком ронял ВСЁ сообщение
    for (const t of ['application/vnd.rar', 'application/x-7z-compressed', 'application/octet-stream', 'application/gzip']) {
      expect(validateUpload(t, 1000).ok).toBe(true);
    }
  });
  it('в отказе называет файл и причину по-русски', () => {
    const r = validateUpload('application/x-msdownload', 1000, MAX_FILE_BYTES, 'вирус.exe');
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('вирус.exe');
    expect((r as { reason: string }).reason).toContain('тип файла');
    const big = validateUpload('image/png', MAX_FILE_BYTES + 1, MAX_FILE_BYTES, 'макет.png');
    expect((big as { reason: string }).reason).toContain('макет.png');
    expect((big as { reason: string }).reason).toContain('25 МБ');
  });
});

describe('sanitizeFileName', () => {
  it('убирает путь (path traversal)', () => {
    expect(sanitizeFileName('../../etc/passwd')).toBe('passwd');
    expect(sanitizeFileName('C:\\temp\\evil.txt')).toBe('evil.txt');
  });
  it('чистит опасные символы', () => {
    expect(sanitizeFileName('a<b>:"|?*.png')).not.toMatch(/[<>:"|?*]/);
  });
  it('пустое имя → file', () => {
    expect(sanitizeFileName('')).toBe('file');
  });
});

describe('имя файла из multipart', () => {
  it('чинит кириллицу, приехавшую байтами latin1', () => {
    const mangled = Buffer.from('условия поставки.txt', 'utf8').toString('latin1');
    expect(mangled).not.toBe('условия поставки.txt'); // именно так приходит из формы
    expect(decodeUploadName(mangled)).toBe('условия поставки.txt');
  });

  it('не трогает уже правильное имя', () => {
    expect(decodeUploadName('Отчёт за квартал.docx')).toBe('Отчёт за квартал.docx');
    expect(decodeUploadName('report.pdf')).toBe('report.pdf');
    expect(decodeUploadName('')).toBe('');
  });

  it('не портит имя, которое не разбирается как UTF-8', () => {
    const weird = 'café.txt'; // настоящая латиница с диакритикой, не мохибейк
    expect(decodeUploadName(weird)).toBe(weird);
  });

  it('вместе с санитизацией даёт читаемое имя', () => {
    const mangled = Buffer.from('Договор №415.pdf', 'utf8').toString('latin1');
    expect(sanitizeFileName(decodeUploadName(mangled))).toBe('Договор №415.pdf');
  });
});
