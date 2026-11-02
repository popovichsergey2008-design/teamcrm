import { last4, plausibleKey, setActiveSecrets, sharedSecret, sourceOf } from './secrets-registry';

describe('реестр общих ключей', () => {
  afterEach(() => { setActiveSecrets(new Map()); delete process.env.X_TEST_KEY; });

  it('показываем только последние 4 символа; короткое — ничего', () => {
    expect(last4('sk-proj-1234567890abcd')).toBe('…abcd');
    expect(last4('short')).toBe('…');
  });

  it('ключ без пробелов и разумной длины', () => {
    expect(plausibleKey('sk-proj-1234567890abcdef')).toBe(true);
    expect(plausibleKey('sk proj 1234567890abcdef')).toBe(false);
    expect(plausibleKey('abc')).toBe(false);
  });

  it('активная версия из реестра сильнее .env; без неё — .env; без обоих — ничего', () => {
    expect(sharedSecret('X_TEST_KEY')).toBeUndefined();
    expect(sourceOf('X_TEST_KEY')).toBe('none');
    process.env.X_TEST_KEY = 'from-env';
    expect(sharedSecret('X_TEST_KEY')).toBe('from-env');
    expect(sourceOf('X_TEST_KEY')).toBe('env');
    setActiveSecrets(new Map([['X_TEST_KEY', 'from-registry']]));
    expect(sharedSecret('X_TEST_KEY')).toBe('from-registry');
    expect(sourceOf('X_TEST_KEY')).toBe('registry');
  });
});
