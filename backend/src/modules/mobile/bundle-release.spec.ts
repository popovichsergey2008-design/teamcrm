import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { bundleForNative, compareVersions, parseBundleRelease } from './bundle-release';
import { MobileConfigService } from './mobile-config.service';
import { MobileController } from './mobile.controller';

const SHA = 'a'.repeat(64);
const good = {
  version: '2026.10.22-abc1234', minNative: '1.50', url: 'https://qevo.one/app/bundle/qevo-web-2026.10.22-abc1234.zip',
  sha256: SHA.toUpperCase(), mandatory: false, sizeBytes: 123, publishedAt: '2026-10-22T10:00:00Z',
};

describe('веб-бандл по воздуху: манифест', () => {
  it('годный манифест разбирается, sha256 — в нижнем регистре', () => {
    const r = parseBundleRelease(good);
    expect(r).toMatchObject({ version: good.version, minNative: '1.50', sha256: SHA, mandatory: false, sizeBytes: 123 });
  });

  it('чужой домен, http, нет суммы или кривая версия — бандла нет', () => {
    expect(parseBundleRelease({ ...good, url: 'https://evil.example/app.zip' })).toBeNull();
    expect(parseBundleRelease({ ...good, url: 'http://qevo.one/app/bundle/x.zip' })).toBeNull();
    expect(parseBundleRelease({ ...good, url: 'https://qevo.one.evil.example/x.zip' })).toBeNull();
    expect(parseBundleRelease({ ...good, sha256: 'abc' })).toBeNull();
    expect(parseBundleRelease({ ...good, version: '../../etc' })).toBeNull();
    expect(parseBundleRelease(null)).toBeNull();
    expect(parseBundleRelease('строка')).toBeNull();
  });

  it('поддомен нашего домена и старый домен допустимы', () => {
    expect(parseBundleRelease({ ...good, url: 'https://dev.qevo.one/app/x.zip' })).not.toBeNull();
    expect(parseBundleRelease({ ...good, url: 'https://anthill.team/app/x.zip' })).not.toBeNull();
  });

  it('подпись берётся, только если похожа на base64', () => {
    expect(parseBundleRelease({ ...good, signature: 'MEUCIQ'.padEnd(40, 'A') })?.signature).toBeDefined();
    expect(parseBundleRelease({ ...good, signature: 'не base64 <script>' })?.signature).toBeUndefined();
  });
});

describe('веб-бандл по воздуху: кому отдавать', () => {
  const r = parseBundleRelease(good);

  it('оболочка не старше minNative получает бандл', () => {
    expect(bundleForNative(r, '1.50')).toBe(r);
    expect(bundleForNative(r, '1.51')).toBe(r);
    expect(bundleForNative(r, '2.0')).toBe(r);
  });

  it('старая оболочка и оболочка без версии — нет', () => {
    expect(bundleForNative(r, '1.49')).toBeNull();
    expect(bundleForNative(r, '')).toBeNull();
    expect(bundleForNative(r, null)).toBeNull();
    expect(bundleForNative(null, '9.9')).toBeNull();
  });

  it('версии сравниваются числами, а не строкой', () => {
    expect(compareVersions('1.10', '1.9')).toBeGreaterThan(0);
    expect(compareVersions('1.50 (77)', '1.50')).toBeGreaterThan(0);
    expect(compareVersions('1.5', '1.5.0')).toBe(0);
  });
});

describe('GET /mobile/bundle', () => {
  let dir: string;
  const platformSettings: Record<string, unknown> = {};
  const platform = { setting: async (k: string, d: unknown) => (k in platformSettings ? platformSettings[k] : d) };
  const make = () => {
    const cfg = new MobileConfigService({} as never, platform as never);
    return new MobileController({} as never, cfg, {} as never);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'bundle-'));
    process.env.ANDROID_RELEASES_DIR = dir;
    delete platformSettings.mobile_bundle;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ANDROID_RELEASES_DIR;
  });

  it('читает bundle/latest.json и отдаёт его совместимой оболочке', async () => {
    mkdirSync(join(dir, 'bundle'));
    writeFileSync(join(dir, 'bundle', 'latest.json'), JSON.stringify(good));
    const c = make();
    expect((await c.bundle({ native: '1.50' })).bundle?.version).toBe(good.version);
    expect((await make().bundle({ native: '1.49' })).bundle).toBeNull();
  });

  it('файла нет — бандла нет, без ошибки', async () => {
    expect((await make().bundle({ native: '1.50' })).bundle).toBeNull();
  });

  it('ручная настройка техотдела главнее файла', async () => {
    mkdirSync(join(dir, 'bundle'));
    writeFileSync(join(dir, 'bundle', 'latest.json'), JSON.stringify(good));
    platformSettings.mobile_bundle = { ...good, version: '2026.10.21-0000000', minNative: '1.0', mandatory: true };
    const r = (await make().bundle({ native: '1.50' })).bundle;
    expect(r).toMatchObject({ version: '2026.10.21-0000000', mandatory: true });
  });
});
