/**
 * Тексты и кнопки Telegram-бота (#4619). Тексты шагов — близко к ТЗ заказчика
 * (private/specs/tz40-00-source-telegram-bot.txt); сообщения ≤ 4–5 строк, всё
 * действие — инлайн-кнопками.
 */

export type Button =
  | { text: string; callback_data: string }
  | { text: string; url: string }
  | { text: string; web_app: { url: string } };
export interface Keyboard { inline_keyboard: Button[][] }

const rows = (...b: Button[]): Keyboard => ({ inline_keyboard: b.map((x) => [x]) });
const cb = (text: string, data: string): Button => ({ text, callback_data: data });

/**
 * Кнопка Mini App. Telegram принимает web_app только с https — на стенде с http
 * (разработка, тесты) отдаём обычную ссылку, иначе Telegram отклонит всё сообщение.
 */
export function appButton(text: string, url: string): Button {
  return /^https:\/\//i.test(url) ? { text, web_app: { url } } : { text, url };
}

export const BOT_NAME = 'QEVO — ИИ-ассистент и задачи';
export const BOT_DESCRIPTION =
  'Превращаю голосовые и переписку в задачи с ТЗ за 2 секунды. Нажмите Старт и проверьте на своем поручении без регистрации.';
export const BOT_SHORT_DESCRIPTION = 'Голосовые и переписка → задачи с ТЗ за 2 секунды. Проверьте без регистрации.';
export const BOT_COMMANDS = [
  { command: 'start', description: 'Начать' },
  { command: 'example', description: 'Проверить на готовом примере' },
  { command: 'login', description: 'Открыть QEVO без пароля' },
  { command: 'task', description: 'Поставить задачу (сотрудникам)' },
  { command: 'daily', description: 'Прислать дейлик (сотрудникам)' },
];

/** Шаг 1 ТЗ: приветствие и три кнопки. */
export function welcome(base: string): { text: string; markup: Keyboard } {
  return {
    text: [
      'Привет! Я ИИ-помощник QEVO. Давайте проверим меня в деле прямо сейчас.',
      '',
      'Запишите мне любое голосовое поручение (например: «Дима, подготовь отчет по рекламе к пятнице 15:00 и добавь сравнение с прошлым месяцем») или нажмите готовый пример ниже.',
    ].join('\n'),
    markup: rows(
      cb('Проверить на готовом примере', 'b:ex'),
      appButton('Открыть демо-доску QEVO (Mini App)', `${base}/tg/board?demo=1`),
      cb('Перенести доски из Битрикс24 / YouGile', 'b:mv'),
    ),
  };
}

/** Привязанному сотруднику /start — приветствие, а не дейлик. */
export function welcomeBack(name: string | null, daysLeft: number | null, base: string): { text: string; markup: Keyboard } {
  return {
    text: [
      `С возвращением${name ? `, ${name}` : ''}! Ваш QEVO на связи.`,
      'Перешлите сообщение клиента или надиктуйте поручение — поставлю задачу на доску. Дейлик — командой /daily.',
      ...(daysLeft !== null ? [`Пробный период: ${daysLeftText(daysLeft)}.`] : []),
    ].join('\n'),
    markup: rows(cb('Открыть мой QEVO', 'b:op'), appButton('Доска в Telegram (Mini App)', `${base}/tg/board`)),
  };
}

export function daysLeftText(n: number): string {
  if (n <= 0) return 'закончился';
  const m10 = n % 10; const m100 = n % 100;
  const word = m10 === 1 && m100 !== 11 ? 'день' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'дня' : 'дней';
  return `${m10 === 1 && m100 !== 11 ? 'остался' : 'осталось'} ${n} ${word}`;
}

/** Шаг 2 ТЗ: кнопки под карточкой. */
export function cardButtons(demoId: string, base: string): Keyboard {
  return rows(
    cb('Забрать задачу в свое пространство (+7 дней бесплатно)', `b:tk:${demoId}`),
    // до регистрации — демо-карточка Mini App без сервера (как в ТЗ)
    appButton('Покликать эту задачу в Mini App', `${base}/tg/task/demo`),
    cb('Надиктовать еще одно поручение', 'b:ag'),
  );
}

export const AGAIN = 'Жду новое поручение: запишите голосовое, перешлите сообщение клиента или напишите текстом.';
export const CANT_PARSE = 'Не нашёл здесь поручения. Напишите, что и кому сделать — например: «Аня, пришли счёт клиенту до завтра».';
export const VOICE_UNAVAILABLE = 'Голосовые сейчас не распознаю — напишите поручение текстом, разберу так же быстро.';
export const VOICE_TOO_LONG = 'Голосовое длиннее 2 минут. Запишите покороче — одно поручение.';
export const VOICE_FAILED = 'Не расслышал голосовое. Запишите ещё раз или напишите текстом.';
export const UNSUPPORTED = 'Пришлите поручение голосовым, текстом или перешлите сообщение клиента — сделаю из него задачу.';

export function userLimit(demoId: string | null): { text: string; markup: Keyboard } {
  return {
    text: 'На сегодня демо-попытки закончились.\nЗаберите задачу в своё пространство — там ИИ разбирает поручения каждый день, а первые 14 дней бесплатно.',
    markup: rows(cb('Создать пространство (+7 дней бесплатно)', `b:tk:${demoId ?? '0'}`)),
  };
}

/** Согласие перед созданием пространства (#4675): ссылка и две кнопки. */
export function consent(base: string, demoId: string): { text: string; markup: Keyboard } {
  return {
    text: [
      'Создам рабочее пространство QEVO на ваш Telegram — без почты и пароля.',
      `Перед этим примите Политику конфиденциальности: ${base}/legal/privacy`,
    ].join('\n'),
    markup: { inline_keyboard: [[cb('Принимаю', `b:ok:${demoId}`), cb('Отмена', 'b:no')]] },
  };
}
export const CONSENT_CANCELLED = 'Хорошо, ничего не создаю. Можно продолжить демо — пришлите ещё одно поручение.';

export function alreadyHas(): { text: string; markup: Keyboard } {
  return {
    text: 'У вас уже есть пространство QEVO — второе не создаю.\nОткрыть его можно в один клик, без пароля.',
    markup: rows(cb('Открыть мой QEVO', 'b:op')),
  };
}

/** Шаг 3 ТЗ: пространство создано, вопрос о размере команды. */
export function created(taskTitle: string | null, project: string | null, taskUrl: string | null = null): { text: string; markup: Keyboard } {
  return {
    text: [
      'Ваше рабочее пространство создано!',
      ...(taskTitle && project ? [`Задача «${taskTitle}» уже на доске «${project}».`] : []),
      'Чтобы я подключил бонусные +7 дней полного доступа (итого 14 дней без карты) и настроил шаблоны, укажите размер вашей команды:',
    ].join('\n'),
    markup: rows(
      cb('До 5 человек', 'b:tm:s'), cb('6 - 15 человек', 'b:tm:m'), cb('16 - 50 человек', 'b:tm:l'), cb('Более 50 человек', 'b:tm:xl'),
      ...(taskUrl ? [appButton('Открыть задачу в Mini App', taskUrl)] : []),
    ),
  };
}

/** Шаг 4 ТЗ: доступ активирован, вход в один клик. */
export function activated(loginLink: string, daysLeft: number | null): { text: string; markup: Keyboard } {
  return {
    text: [
      'Доступ на 14 дней для вашей команды активирован!',
      'Вы можете продолжить работу прямо здесь в Telegram или открыть полную версию на компьютере в 1 клик (пароль не нужен).',
      ...(daysLeft !== null ? [`Пробный период: ${daysLeftText(daysLeft)}.`] : []),
    ].join('\n'),
    markup: rows(
      { text: 'Открыть QEVO на компьютере / телефоне', url: loginLink },
      cb('Пригласить коллег по ссылке', 'b:in'),
      cb('Заказать бесплатный переезд за 24 часа', 'b:mv'),
    ),
  };
}

export function loginLinkMessage(loginLink: string): { text: string; markup: Keyboard } {
  return {
    text: 'Ссылка для входа без пароля: срабатывает один раз и действует 10 минут.',
    markup: rows({ text: 'Открыть QEVO', url: loginLink }),
  };
}
export const NO_SPACE = 'Пространства QEVO у вас пока нет. Пришлите поручение — сделаю задачу, а кнопка «Забрать задачу» создаст пространство.';

export function invite(link: string): { text: string; markup: Keyboard } {
  return {
    text: `Ссылка для коллег — по ней они войдут в вашу команду (действует 30 дней):\n${link}`,
    markup: rows({
      text: 'Отправить коллегам',
      url: `https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent('Присоединяйся к нашей команде в QEVO')}`,
    }),
  };
}
export const INVITE_DENIED = 'Приглашать коллег может владелец или руководитель пространства.';

export function moveFrom(): { text: string; markup: Keyboard } {
  return {
    text: 'Откуда переносим доски? Инженер QEVO бесплатно перенесёт проекты, задачи и комментарии за 24 часа.',
    markup: {
      inline_keyboard: [
        [cb('Битрикс24', 'b:fr:b24'), cb('YouGile', 'b:fr:yg')],
        [cb('Jira', 'b:fr:jira'), cb('Другое', 'b:fr:oth')],
      ],
    },
  };
}
export const MOVE_ACCEPTED = 'Заявка принята! Инженер QEVO напишет вам здесь, в Telegram, в течение 24 часов и пришлёт план переезда.';
export const MOVE_REPEAT = 'Заявка на переезд уже у инженера — он напишет вам в течение 24 часов.';
export const SOMETHING_WRONG = 'Что-то пошло не так — попробуйте ещё раз через минуту.';

// ───────────── рабочий бот для команды (этап 4) ─────────────

/** Голос/текст без явного выбора: задача или дейлик. */
export function askTaskOrDaily(): { text: string; markup: Keyboard } {
  return {
    text: 'Что сделать с этим сообщением?\nВыбор запомню на 10 минут — следующие сообщения разложу так же.',
    markup: { inline_keyboard: [[cb('Поставить задачу', 'b:tq'), cb('Это мой дейлик', 'b:dq')]] },
  };
}
export const ASK_EXPIRED = 'Сообщение уже не помню — пришлите его ещё раз.';
export const DAILY_MODE = 'Жду дейлик: присылайте текстом или голосом в ближайшие 10 минут.';
export const TASK_MODE = 'Жду поручения: перешлите сообщение или надиктуйте — поставлю задачей. Режим — на 10 минут.';
export const TASK_VOICE_TOO_LONG = 'Голосовое длиннее 5 минут — для поручения это много. Запишите короче или пришлите как дейлик (/daily).';
export const TASK_VOICE_FAILED = 'Не расслышал голосовое. Запишите ещё раз или напишите поручение текстом.';
export const TASK_NOT_PARSED = 'Не нашёл здесь поручения. Напишите, что и кому сделать — например: «Аня, пришли счёт клиенту до завтра».';
export const TASK_NO_PROJECT = 'Не понял, в какой проект поставить задачу. Назовите проект в сообщении или поставьте задачу в QEVO.';

/** Карточка поставленной задачи: Mini App и «Отменить». */
export function taskButtons(taskId: string, base: string): Keyboard {
  return {
    inline_keyboard: [
      [appButton('Открыть в Mini App', `${base}/tg/task/${taskId}`)],
      [cb('Отменить', `b:ux:${taskId}`)],
    ],
  };
}
export const TASK_CANCELLED = 'Задача отменена — она в корзине QEVO.';
export const TASK_CANCEL_LATE = 'Отменить можно только свою задачу в первые 10 минут. Удалить её можно в QEVO.';

/** Сдача работы на проверку: две кнопки и карточка в Mini App. */
export function approvalAsk(c: { taskId: string; title: string; who: string | null; project: string; base: string }): { text: string; markup: Keyboard } {
  return {
    text: [
      `📥 Работа сдана на проверку: «${c.title}»`,
      `Исполнитель: ${c.who ?? 'не назначен'} · Проект: ${c.project}`,
    ].join('\n'),
    markup: {
      inline_keyboard: [
        [cb('Принять работу', `b:ap:${c.taskId}`), cb('Вернуть на доработку', `b:rw:${c.taskId}`)],
        [appButton('Открыть задачу', `${c.base}/tg/task/${c.taskId}`)],
      ],
    },
  };
}
export const approved = (title: string) => `✅ Работа принята: «${title}». Задача закрыта.`;
export const returned = (title: string) => `↩️ Вернул на доработку: «${title}». Исполнитель увидит причину.`;
export const RETURN_ASK = 'Напишите ответом, что доработать, — передам исполнителю вместе с возвратом.';
export const NOT_PENDING = 'Эта задача уже не ждёт проверки.';
export const NOT_YOURS = 'Принять или вернуть работу может постановщик задачи или владелец.';
export const TASK_GONE = 'Задача не найдена.';

/** Утренний фокус: три строки и куда пойти. */
export function focusMessage(text: string, base: string): { text: string; markup: Keyboard } {
  return {
    text,
    markup: rows({ text: 'Открыть Фокус дня', url: `${base}/focus` }, appButton('Доска в Telegram', `${base}/tg/board`)),
  };
}

/** 4-й день пробного периода: досок не переносили — предложить инженера. */
export function moveOffer(): { text: string; markup: Keyboard } {
  return {
    text: [
      'Старые проекты всё ещё в другой системе?',
      'Инженер QEVO бесплатно перенесёт доски, задачи и комментарии из Битрикс24, YouGile или Jira за сутки.',
    ].join('\n'),
    markup: rows(cb('Подключить инженера для переноса', 'b:mv')),
  };
}
