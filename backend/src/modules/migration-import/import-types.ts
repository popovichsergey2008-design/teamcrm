/**
 * Общий вид переписки, приехавшей из Slack или Telegram (#4902, п. 4).
 *
 * Разборщики архивов приводят каждый свой формат к этому виду, а запись в базу знает
 * только его. Так у двух источников один и тот же перенос, одни и те же правила
 * авторов и дат и один отчёт — расхождения между «Slack перенёсся так, а Telegram
 * иначе» взяться неоткуда.
 */
export type ImportSource = 'slack' | 'telegram';

/** Вид чата в старой системе: от него зависит, во что он превратится у нас. */
export type ImportChatKind =
  | 'channel'      // открытый канал Slack → чат проекта
  | 'private'      // закрытый канал Slack → закрытый канал
  | 'dm'           // личная переписка Slack → личный диалог
  | 'mpim'         // групповая личка Slack → группа
  | 'tg_group'     // группа Telegram → группа
  | 'tg_channel'   // канал Telegram → группа
  | 'tg_personal'; // личная переписка Telegram → группа (по выбору человека)

export interface ImportPerson {
  /** id в старой системе: U123 у Slack, user123 у Telegram. */
  ext: string;
  name: string;
  email: string | null;
  isBot: boolean;
  deleted: boolean;
}

export interface ImportFile {
  /** Устойчивый id файла в старой системе — по нему повтор импорта не качает файл второй раз. */
  ext: string;
  name: string;
  mime: string | null;
  size: number | null;
  /** Slack: ссылка на скачивание (с токеном из архива). */
  url?: string | null;
  /** Telegram: путь файла внутри архива. */
  zipPath?: string | null;
  /** Почему файл заведомо не перенести — идёт в отчёт «не удалось». */
  missing?: string | null;
}

export interface ImportMessage {
  /** id сообщения в чате старой системы: ts у Slack, номер у Telegram. */
  ext: string;
  /** Время сообщения, мс. Дата переносится как была — это половина условия «Готово». */
  at: number;
  /** Автор: id в старой системе; null — автора нет (удалённый аккаунт). */
  authorExt: string | null;
  /** Имя автора как в старой системе — подпись, если человека нет в команде. */
  authorName: string;
  body: string;
  /** Ветка: ext корневого сообщения (Slack thread_ts). */
  threadExt?: string | null;
  /** Ответ из ветки, продублированный в канал. */
  broadcast?: boolean;
  /** Ответ с цитатой в ленте (Telegram reply_to_message_id). */
  replyToExt?: string | null;
  files: ImportFile[];
}

export interface ImportChat {
  ext: string;
  kind: ImportChatKind;
  title: string;
  /** Участники по данным старой системы (Slack). У Telegram — авторы сообщений. */
  memberExts: string[];
  /** Описание/тема канала — в описание нашего чата. */
  description?: string | null;
  messages: ImportMessage[];
}

export interface ImportBundle {
  source: ImportSource;
  /** Кого переносим: команда Slack или чат Telegram. Основа ключей идемпотентности. */
  sourceKey: string;
  people: ImportPerson[];
  chats: ImportChat[];
  /** Служебные строки (вошёл в канал, сменил тему) — не переписка, их не переносим. */
  skippedService: number;
  warnings: string[];
}

/** Что показываем человеку до переноса: из чего выбирать. */
export interface ScanChat {
  key: string;
  title: string;
  kind: ImportChatKind;
  messages: number;
  files: number;
  /** Отмечен ли по умолчанию: открытые каналы и группы — да, чужие лички Telegram — нет. */
  selected: boolean;
  firstAt: string | null;
  lastAt: string | null;
}

export interface ScanSummary {
  source: ImportSource;
  chats: ScanChat[];
  people: number;
  peopleWithEmail: number;
  messages: number;
  files: number;
  warnings: string[];
}

/** Сводка архива — чистая функция, чтобы проверять её тестом без базы. */
export function summarize(bundle: ImportBundle): ScanSummary {
  const iso = (ms: number | undefined) => (ms === undefined || !Number.isFinite(ms) ? null : new Date(ms).toISOString());
  const chats = bundle.chats.map((c) => {
    // reduce, а не Math.min(...): у канала за пять лет сотни тысяч сообщений, и
    // разворот такого массива в аргументы роняет процесс переполнением стека
    let first: number | undefined;
    let last: number | undefined;
    for (const m of c.messages) {
      if (!Number.isFinite(m.at)) continue;
      if (first === undefined || m.at < first) first = m.at;
      if (last === undefined || m.at > last) last = m.at;
    }
    return {
      key: c.ext,
      title: c.title,
      kind: c.kind,
      messages: c.messages.length,
      files: c.messages.reduce((n, m) => n + m.files.length, 0),
      selected: c.kind !== 'tg_personal',
      firstAt: iso(first),
      lastAt: iso(last),
    };
  });
  return {
    source: bundle.source,
    chats,
    people: bundle.people.filter((p) => !p.isBot).length,
    peopleWithEmail: bundle.people.filter((p) => !p.isBot && p.email).length,
    messages: chats.reduce((n, c) => n + c.messages, 0),
    files: chats.reduce((n, c) => n + c.files, 0),
    warnings: bundle.warnings.slice(0, 20),
  };
}
