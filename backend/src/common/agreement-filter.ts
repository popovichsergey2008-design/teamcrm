/**
 * Договорённость со встречи — только настоящая (#4891, п. 8). Фраза без действия и без
 * результата («сейчас мит закрою, и у меня ничего нету») в договорённости и в бриф не
 * попадает. «Это не обещание» пополняет список компании: похожие фразы дальше тоже
 * отсеиваются. Чистая функция — её зовут и Фокус, и бриф.
 */

const ACTION = /(?:сдела|подготов|отправ|пришл|пришлю|напиш|позвон|созвон|провер|соглас|обнов|исправ|добав|настро|запуст|оформ|посчита|собер|соберу|выложи|передам|передат|договор|встрет|закро[юе]т? задач|верн[уё]|дошл|скин|заплат|оплат|опубликуй|опубликова|обсуд|разбер|покаж|покаж|закаж|согласу|утверд|подпиш|выстав|запиш|сверст|протестир|задеплой|выкат|релиз|до \d|к \d|завтра|сегодня|в понедельник|во вторник|в среду|в четверг|в пятницу|на неделе|до конца)/i;
const RESULT = /(?:отч[её]т|документ|договор|сч[её]т|макет|презентац|таблиц|спис|план|смет|ТЗ|задач|письм|релиз|верси|прототип|дизайн|бюджет|оффер|кп(?![а-яё])|коммерческ)/i;
const JUNK = /^(?:ну|так|ладно|окей|ок|ага|угу|да|нет|короче|слушай|смотри|всё|все)[\s,.!-]*$|ничего нет|у меня ничего|мит закро|созвон закро|звонок закро|слышно|видно меня|меня слышно|перезайду|отвалил|связь пропала|минутку|секунду/i;

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const words = (s: string) => new Set(norm(s).split(' ').filter((w) => w.length > 2));

/** Похожа ли фраза на то, что уже отметили «не обещание» (доля общих слов ≥ 0,6). */
export function likeLearned(text: string, learned: string[]): boolean {
  const a = words(text);
  if (!a.size) return false;
  return learned.some((l) => {
    const b = words(l);
    if (!b.size) return false;
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    return common / Math.max(a.size, b.size) >= 0.6;
  });
}

export function isRealAgreement(text: string | null | undefined, learned: string[] = []): boolean {
  const t = (text ?? '').trim();
  if (t.length < 8) return false;
  if (JUNK.test(t) && !RESULT.test(t)) return false;
  if (!ACTION.test(t) && !RESULT.test(t)) return false;
  return !likeLearned(t, learned);
}

export const normalizePhrase = (s: string) => norm(s).slice(0, 300);

/** Для брифа: решение со встречи не цитируем, если это пустая реплика или её отметили «не обещание». */
export function isJunkPhrase(text: string | null | undefined, learned: string[] = []): boolean {
  const t = (text ?? '').trim();
  if (t.length < 8) return true;
  if (JUNK.test(t) && !RESULT.test(t)) return true;
  return likeLearned(t, learned);
}
