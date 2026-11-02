import { launchKind, osOf, parseDownload } from './install-rules';

describe('parseDownload', () => {
  it('APK с источником', () => {
    expect(parseDownload('/app/qevo-1.52.apk?src=site')).toEqual({ file: 'qevo-1.52.apk', version: '1.52', source: 'site' });
    expect(parseDownload('/app/qevo-1.52.apk?src=app')).toMatchObject({ source: 'app' });
  });
  it('без источника или с чужим — прямая ссылка', () => {
    expect(parseDownload('/app/qevo-1.52.apk')).toMatchObject({ source: 'direct' });
    expect(parseDownload('/app/qevo-1.52.apk?src=<script>')).toMatchObject({ source: 'direct' });
  });
  it('не дистрибутив — не считаем', () => {
    expect(parseDownload('/app/latest.json')).toBeNull();
    expect(parseDownload('/app/bundle/x.zip')).toBeNull();
    expect(parseDownload('/app/../etc/qevo-1.apk')).toBeNull();
  });
});

describe('osOf', () => {
  it('коротко', () => {
    expect(osOf('Mozilla/5.0 (Linux; Android 14; SM-A525F) AppleWebKit')).toBe('Android 14');
    expect(osOf('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows');
    expect(osOf('')).toBeNull();
  });
});

describe('launchKind', () => {
  it('первый запуск, обновление, обычный день', () => {
    expect(launchKind(null, '1.52')).toBe('first_run');
    expect(launchKind({ version: '1.51' }, '1.52')).toBe('update');
    expect(launchKind({ version: '1.52' }, '1.52')).toBe('seen');
    expect(launchKind({ version: null }, '1.52')).toBe('seen');
  });
});
