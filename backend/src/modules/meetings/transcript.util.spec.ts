import { parseSubtitles, parseTimecode, repliesToText, shiftSegments, splitSpeaker } from './transcript.util';

describe('Встречи: разбор стенограмм', () => {
  it('таймкоды WebVTT и SubRip', () => {
    expect(parseTimecode('00:01:02.500')).toBeCloseTo(62.5);
    expect(parseTimecode('00:01:02,500')).toBeCloseTo(62.5); // SubRip пишет запятую
    expect(parseTimecode('01:02.500')).toBeCloseTo(62.5);    // час можно опустить
    expect(parseTimecode('1:00:00.000')).toBeCloseTo(3600);
    expect(Number.isNaN(parseTimecode('не таймкод'))).toBe(true);
  });

  it('говорящий: тег <v> и «Имя: реплика»', () => {
    expect(splitSpeaker('<v Иван Петров>Привет всем</v>')).toEqual({ speaker: 'Иван Петров', text: 'Привет всем' });
    expect(splitSpeaker('Алина: беру интеграцию')).toEqual({ speaker: 'Алина', text: 'беру интеграцию' });
  });

  it('обычную фразу с двоеточием за говорящего не принимаем', () => {
    // иначе «Итак: делаем так» превратилось бы в реплику несуществующего человека «Итак»
    expect(splitSpeaker('Смотрите что получилось: всё работает').speaker).toBeNull();
    expect(splitSpeaker('Вот и всё. Итого: три задачи').speaker).toBeNull();
  });

  it('разбирает WebVTT с именами и многострочными репликами', () => {
    const vtt = [
      'WEBVTT', '',
      '1', '00:00:01.000 --> 00:00:04.000', '<v Иван Петров>Начнём со сроков',
      '', '2', '00:00:05.000 --> 00:00:09.000', 'Алина: беру на себя интеграцию', 'сделаю к пятнице',
    ].join('\n');

    const r = parseSubtitles(vtt);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ start: 1, end: 4, speaker: 'Иван Петров', text: 'Начнём со сроков' });
    expect(r[1].speaker).toBe('Алина');
    expect(r[1].text).toBe('беру на себя интеграцию сделаю к пятнице');
  });

  it('разбирает SubRip', () => {
    const srt = ['1', '00:00:02,000 --> 00:00:03,500', 'Проверка связи'].join('\n');
    expect(parseSubtitles(srt)).toEqual([{ start: 2, end: 3.5, speaker: null, text: 'Проверка связи' }]);
  });

  it('битые блоки пропускаются, а не роняют разбор', () => {
    const junk = ['мусор без таймкода', '', '00:00:01.000 --> 00:00:02.000', '', '', 'ещё мусор'].join('\n');
    expect(parseSubtitles(junk)).toEqual([]); // блок без текста и блоки без времени — мимо
  });

  it('куски записи сшиваются со смещением', () => {
    // Whisper во втором куске снова считает время с нуля — без смещения ленты наложатся
    const chunk2 = [{ start: 0, end: 5, text: 'вторая часть' }];
    expect(shiftSegments(chunk2, 600)).toEqual([{ start: 600, end: 605, speaker: null, text: 'вторая часть' }]);
  });

  it('лента для LLM содержит время и говорящего', () => {
    const text = repliesToText([
      { start: 62, end: 65, speaker: 'Алина', text: 'беру интеграцию' },
      { start: 3600, end: 3605, speaker: null, text: 'подводим итоги' },
    ]);
    expect(text).toBe('[01:02] Алина: беру интеграцию\n[60:00] подводим итоги');
  });
});
