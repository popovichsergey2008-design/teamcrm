/**
 * Ошибки проверки полей по-русски (#4779, п. 9): class-validator без своего текста
 * отвечает «email must be an email» — человек в форме вступления видел именно это.
 * Переводим стандартные фразы в одном месте, чтобы ни одна форма (регистрация, вход,
 * сброс пароля, приглашение и все остальные) не показала английскую строку.
 */
export const EMAIL_HINT = 'Проверьте почту, похоже, в адресе ошибка. Пример: name@company.ru';

const FIELDS: Record<string, string> = {
  email: 'Почта', password: 'Пароль', newPassword: 'Новый пароль', currentPassword: 'Текущий пароль',
  fullName: 'Имя', name: 'Название', tenantName: 'Название пространства', title: 'Название',
  description: 'Описание', phone: 'Телефон', token: 'Ссылка', code: 'Код', text: 'Текст', body: 'Текст',
};
const field = (f: string) => `«${FIELDS[f] ?? f}»`;

const RULES: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^(\S+) must be an email$/, () => EMAIL_HINT],
  [/^property (\S+) should not exist$/, (m) => `Лишнее поле ${field(m[1])} — обновите страницу и попробуйте ещё раз`],
  [/^(\S+) should not be empty$/, (m) => `Заполните поле ${field(m[1])}`],
  [/^(\S+) must be longer than or equal to (\d+) characters?$/, (m) => `Поле ${field(m[1])} — не короче ${m[2]} символов`],
  [/^(\S+) must be shorter than or equal to (\d+) characters?$/, (m) => `Поле ${field(m[1])} — не длиннее ${m[2]} символов`],
  [/^(\S+) must be a string$/, (m) => `Поле ${field(m[1])} должно быть текстом`],
  [/^(\S+) must be a boolean value$/, (m) => `Поле ${field(m[1])} — да или нет`],
  [/^(\S+) must be an integer number$/, (m) => `Поле ${field(m[1])} — целое число`],
  [/^(\S+) must be a number conforming to the specified constraints$/, (m) => `Поле ${field(m[1])} — число`],
  [/^(\S+) must not be less than (\S+)$/, (m) => `Поле ${field(m[1])} — не меньше ${m[2]}`],
  [/^(\S+) must not be greater than (\S+)$/, (m) => `Поле ${field(m[1])} — не больше ${m[2]}`],
  [/^(\S+) must be one of the following values: (.+)$/, (m) => `Поле ${field(m[1])}: выберите один из вариантов (${m[2]})`],
  [/^(\S+) must be a valid ISO 8601 date string$/, (m) => `Поле ${field(m[1])} — дата`],
  [/^(\S+) must be a URL address$/, (m) => `Поле ${field(m[1])} — ссылка, например https://site.ru`],
  [/^(\S+) must be an array$/, (m) => `Поле ${field(m[1])} — список`],
  [/^(\S+) must be an object$/, (m) => `Поле ${field(m[1])} заполнено неверно`],
  [/^(\S+) must be a UUID$/, (m) => `Поле ${field(m[1])} заполнено неверно`],
  [/^(\S+) must match .+ regular expression$/, (m) => `Поле ${field(m[1])} заполнено неверно`],
];

/** Одна фраза class-validator → по-русски; своё (уже русское) сообщение — как есть. */
export function validationRu(msg: string): string {
  const s = String(msg).trim();
  // вложенные поля: «items.0.title must be a string» — по последнему имени
  const flat = s.replace(/^(?:[\w]+\.)+(?=\w+ )/, '');
  for (const [re, fn] of RULES) {
    const m = flat.match(re);
    if (m) return fn(m);
  }
  return s;
}
