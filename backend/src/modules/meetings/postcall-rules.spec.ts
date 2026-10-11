import { parseStamp, validateMeetingAnalysis } from './meeting-schema';
import { draftConfidence, newsKind, speakerAt } from './postcall-rules';

const replies = [
  { start: 0, text: 'Начинаем планёрку', speaker: 'Борис', speakerUserId: '1' },
  { start: 62, text: 'Гостевая ссылка работает без регистрации, так и оставляем', speaker: 'Борис', speakerUserId: '1' },
  { start: 1874, text: 'Глеб, проверь подключение гостя с мобильного до среды', speaker: 'Сергей', speakerUserId: '2' },
  { start: 1900, text: 'Хорошо', speaker: 'Глеб', speakerUserId: '3' },
];

describe('итоги встречи: источник пункта', () => {
  it('метки стенограммы читаются, мусор — нет', () => {
    expect(parseStamp('31:14')).toBe(1874);
    expect(parseStamp('[01:02]')).toBe(62);
    expect(parseStamp('1:02:05')).toBe(3725);
    expect(parseStamp('75:10')).toBe(4510);
    expect(parseStamp(90)).toBe(90);
    expect(parseStamp('12:75')).toBeNull();
    expect(parseStamp('вчера')).toBeNull();
    expect(parseStamp(null)).toBeNull();
  });

  it('говорящий — по реплике в эту секунду, а не со слов модели', () => {
    expect(speakerAt(replies, 1880)).toEqual({ sec: 1880, speaker: 'Сергей', speakerUserId: '2' });
    expect(speakerAt(replies, 61.5).speaker).toBe('Борис');
  });

  it('метки нет — ищем реплику по цитате', () => {
    expect(speakerAt(replies, null, 'Глеб, проверь подключение гостя с мобильного')).toEqual({ sec: 1874, speaker: 'Сергей', speakerUserId: '2' });
    expect(speakerAt(replies, null, 'Сергей: Глеб, проверь подключение гостя')).toMatchObject({ sec: 1874, speaker: 'Сергей' });
    expect(speakerAt(replies, null, 'чего не было')).toEqual({ sec: null, speaker: null, speakerUserId: null });
    expect(speakerAt(replies, null, 'да')).toEqual({ sec: null, speaker: null, speakerUserId: null }); // слишком коротко
  });

  it('метка далеко за концом записи — источника нет', () => {
    expect(speakerAt(replies, 9000).sec).toBeNull();
  });

  it('в «Новости» — только вехи, обычные итоги — нет', () => {
    expect(newsKind(['Релиз — в пятницу'])).toBe('release');
    expect(newsKind(['Запускаем гостевые ссылки для всех'])).toBe('release');
    expect(newsKind(['Договор с «Аэрос» подписали'])).toBe('milestone');
    expect(newsKind(['Форму входа не трогаем', 'Созвон по четвергам'])).toBeNull();
    expect(newsKind(['Перезапуск сервера ночью'])).toBeNull(); // «перезапуск» — не запуск
  });

  it('уверенность в исполнителе', () => {
    expect(draftConfidence(true, 'high')).toBe(0.9);
    expect(draftConfidence(true, null)).toBe(0.9);
    expect(draftConfidence(true, 'medium')).toBe(0.6);
    expect(draftConfidence(false, 'high')).toBe(0.3);
  });

  it('разбор: решения и вопросы с метками, задача с уверенностью и срочностью; старый формат тоже', () => {
    const { value } = validateMeetingAnalysis({
      summary: 'Обсудили гостевые ссылки',
      decisions: [{ text: 'Ссылка без регистрации', at: '01:02' }, 'Релиз в пятницу'],
      questions: [{ text: 'Нужен ли пароль на ссылку?', at: null }],
      risks: [],
      tasks: [{ title: 'Проверить мобильный вход', assignee: 'Глеб', at: '31:14', confidence: 'medium', urgent: true, quote: 'проверь' }],
    });
    expect(value!.decisions).toEqual([{ text: 'Ссылка без регистрации', sec: 62 }, { text: 'Релиз в пятницу', sec: null }]);
    expect(value!.questions).toEqual([{ text: 'Нужен ли пароль на ссылку?', sec: null }]);
    expect(value!.tasks[0]).toMatchObject({ sec: 1874, confidence: 'medium', urgent: true });
  });
});
