import { matches, normalize } from './custom-responses.service';

/**
 * Срабатывание быстрых ответов проверяем правилами: ошибка здесь видна не как
 * падение, а как бот, отвечающий невпопад в рабочем чате, — и замечают её люди,
 * а не мы.
 */
describe('быстрые ответы: когда срабатывать', () => {
  const kw = (trigger: string) => ({ trigger, match_kind: 'keyword' });

  it('ключевые слова через запятую — срабатывает любое', () => {
    expect(matches(kw('vpn, впн'), normalize('ребята, где взять впн?'))).toBe(true);
    expect(matches(kw('vpn, впн'), normalize('а VPN кто настраивал?'))).toBe(true);
    expect(matches(kw('vpn, впн'), normalize('обсудим доступы завтра'))).toBe(false);
  });

  it('слово ищется целиком: «вид» не ловит «видео»', () => {
    expect(matches(kw('вид'), normalize('а где видео с мита?'))).toBe(false);
    expect(matches(kw('вид'), normalize('покажи вид сверху'))).toBe(true);
  });

  it('фраза из нескольких слов ищется вхождением', () => {
    expect(matches(kw('заявка на отпуск'), normalize('как подать заявку на отпуск?'))).toBe(false);
    expect(matches(kw('заявка на отпуск'), normalize('нужна заявка на отпуск, где бланк'))).toBe(true);
  });

  it('точное совпадение — только целиком, но без регистра и знаков', () => {
    const ex = { trigger: 'VPN', match_kind: 'exact' };
    expect(matches(ex, normalize('vpn'))).toBe(true);
    expect(matches(ex, normalize('VPN?'))).toBe(true);
    expect(matches(ex, normalize('а что с vpn'))).toBe(false);
  });

  it('«ё» и «е» — одно и то же: люди пишут и так, и так', () => {
    expect(matches(kw('учёт'), normalize('где учет часов?'))).toBe(true);
  });
});
