import { dropHallucinations, isHallucination, stripHallucinationEdges } from './stt-hallucinations';

const seg = (text: string, noSpeechProb = 0.1, avgLogprob = -0.3, start = 0) => ({ start, end: start + 2, text, noSpeechProb, avgLogprob });

describe('выдумки распознавания на тишине', () => {
  it('известные фразы из роликов убираются, если это весь фрагмент', () => {
    expect(isHallucination(seg('Приветствую вас, дорогие друзья и гости канала «АвтоСтронг-М»!'))).toBe(true);
    expect(isHallucination(seg('Продолжение следует...'))).toBe(true);
    expect(isHallucination(seg('Субтитры сделал DimaTorzok'))).toBe(true);
    expect(isHallucination(seg('Спасибо за просмотр!'))).toBe(true);
  });

  it('живая речь остаётся, даже с похожими словами', () => {
    expect(isHallucination(seg('Привет!'))).toBe(false);
    expect(isHallucination(seg('Помогите.'))).toBe(false);
    expect(isHallucination(seg('Давайте мы создадим первую задачу и дальше идём по задачам.'))).toBe(false);
    expect(isHallucination(seg('Ну и до новых встреч с клиентом в пятницу договорились, там обсудим макет и смету подробно'))).toBe(false);
  });

  it('модель сама считает, что речи нет, — убираем', () => {
    expect(isHallucination(seg('Ну да.', 0.85, -1.1))).toBe(true);
    expect(isHallucination(seg('Ну да.', 0.85, -0.2))).toBe(false);
  });

  it('эхо одной фразы на тишине убирается, разные реплики остаются', () => {
    const list = [
      seg('Это тестовая фраза из тишины', 0.5, -0.5, 0), seg('Это тестовая фраза из тишины', 0.2, -0.5, 20),
      seg('Это тестовая фраза из тишины', 0.2, -0.5, 40), seg('Нет, наша сервисная часть.', 0.05, -0.2, 60),
    ];
    expect(dropHallucinations(list).map((s) => s.text)).toEqual(['Нет, наша сервисная часть.']);
  });
});

describe('stripHallucinationEdges', () => {
  it('срезает выдумку в конце надиктовки (26.10: «С вами был Игорь Негода»)', () => {
    const said = 'То есть ещё раз зайти, пересмотреть миссию — каким образом это сделать? У меня нет больше доступа к инфоцентру.';
    expect(stripHallucinationEdges(`${said}\n\nС вами был Игорь Негода.`)).toBe(said);
    expect(stripHallucinationEdges(`${said} Продолжение следует... Субтитры сделал DimaTorzok`)).toBe(said);
  });

  it('живую речь не трогает: и с «спасибо за просмотр» внутри фразы', () => {
    const t = 'Скинь, пожалуйста, ссылку. Спасибо за просмотр макета, всё понятно.';
    expect(stripHallucinationEdges(t)).toBe(t);
    expect(stripHallucinationEdges('Поставь задачу Глебу на завтра')).toBe('Поставь задачу Глебу на завтра');
  });

  it('целиком выдумка — пусто', () => {
    expect(stripHallucinationEdges('Продолжение следует...')).toBe('');
  });
});
