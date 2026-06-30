import { MAX_FILE_BYTES, sanitizeFileName, validateUpload } from './files.validation';

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
