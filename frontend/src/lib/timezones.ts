/**
 * Список часовых поясов для выбора — как в системных настройках: «(UTC+03:00) Москва».
 *
 * Список не хранится в коде, а строится браузером: `Intl.supportedValuesOf('timeZone')`
 * знает все пояса и, что важнее, их актуальные правила. Табличка из четырёхсот строк
 * устарела бы при первом же переносе перевода часов — а это уже случалось и с Россией,
 * и с Европой, и правили бы мы её вручную и с опозданием.
 *
 * Смещение считаем на текущий момент: летом и зимой у половины поясов оно разное,
 * и человек должен видеть то, которое действует сейчас.
 */

/** Русские названия для поясов, которыми пользуется команда. Остальные — как есть. */
const RU_NAMES: Record<string, string> = {
  'Europe/Kaliningrad': 'Калининград',
  'Europe/Moscow': 'Москва, Санкт-Петербург',
  'Europe/Samara': 'Самара, Ижевск',
  'Europe/Volgograd': 'Волгоград',
  'Europe/Saratov': 'Саратов',
  'Europe/Astrakhan': 'Астрахань',
  'Europe/Kirov': 'Киров',
  'Europe/Ulyanovsk': 'Ульяновск',
  'Asia/Yekaterinburg': 'Екатеринбург',
  'Asia/Omsk': 'Омск',
  'Asia/Novosibirsk': 'Новосибирск',
  'Asia/Barnaul': 'Барнаул',
  'Asia/Tomsk': 'Томск',
  'Asia/Krasnoyarsk': 'Красноярск',
  'Asia/Novokuznetsk': 'Новокузнецк',
  'Asia/Irkutsk': 'Иркутск',
  'Asia/Yakutsk': 'Якутск',
  'Asia/Chita': 'Чита',
  'Asia/Khandyga': 'Хандыга',
  'Asia/Vladivostok': 'Владивосток',
  'Asia/Ust-Nera': 'Усть-Нера',
  'Asia/Magadan': 'Магадан',
  'Asia/Sakhalin': 'Южно-Сахалинск',
  'Asia/Srednekolymsk': 'Среднеколымск',
  'Asia/Kamchatka': 'Петропавловск-Камчатский',
  'Asia/Anadyr': 'Анадырь',
  'Europe/Minsk': 'Минск',
  'Europe/Kyiv': 'Киев',
  'Asia/Almaty': 'Алматы',
  'Asia/Aqtobe': 'Актобе',
  'Asia/Tashkent': 'Ташкент',
  'Asia/Tbilisi': 'Тбилиси',
  'Asia/Yerevan': 'Ереван',
  'Asia/Baku': 'Баку',
  'Asia/Bishkek': 'Бишкек',
  'Asia/Dushanbe': 'Душанбе',
  'Asia/Ashgabat': 'Ашхабад',
  'Europe/Chisinau': 'Кишинёв',
  UTC: 'UTC',
};

/** Запасной список, если браузер не умеет перечислять пояса (старые Safari и Edge). */
const FALLBACK = [
  'Europe/Kaliningrad', 'Europe/Moscow', 'Europe/Samara', 'Asia/Yekaterinburg', 'Asia/Omsk',
  'Asia/Krasnoyarsk', 'Asia/Irkutsk', 'Asia/Yakutsk', 'Asia/Vladivostok', 'Asia/Magadan',
  'Asia/Kamchatka', 'Europe/Minsk', 'Europe/Kyiv', 'Asia/Almaty', 'Asia/Tbilisi', 'Asia/Yerevan',
  'Asia/Baku', 'Asia/Tashkent', 'Europe/Berlin', 'Europe/London', 'Europe/Lisbon', 'Asia/Dubai',
  'Asia/Bangkok', 'America/New_York', 'America/Los_Angeles', 'UTC',
];

/**
 * Смещение пояса от UTC в минутах на заданный момент.
 * Считаем через форматирование той же даты в нужном поясе — это единственный способ,
 * который учитывает и переход на летнее время, и исторические правки правил.
 */
export function offsetMinutes(timeZone: string, at: Date = new Date()): number {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    }).formatToParts(at);
    const v: Record<string, number> = {};
    for (const p of parts) if (p.type !== 'literal') v[p.type] = Number(p.value);
    // час 24 вместо 0 встречается в некоторых движках — приводим к обычному виду
    const hour = v.hour === 24 ? 0 : v.hour;
    const asIfUtc = Date.UTC(v.year, v.month - 1, v.day, hour, v.minute, v.second);
    return Math.round((asIfUtc - at.getTime()) / 60_000);
  } catch {
    return 0; // неизвестный пояс не должен ронять экран настроек
  }
}

/** «+03:00», «−05:30», «+00:00» — как в системных настройках. */
export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '−' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
}

export type TimezoneOption = { id: string; label: string; offset: number };

/**
 * Все пояса, отсортированные по смещению — привычный порядок для такого списка.
 * При равном смещении сортируем по названию, чтобы порядок не прыгал между заходами.
 */
export function listTimezones(at: Date = new Date()): TimezoneOption[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
  let ids: string[];
  try {
    ids = supported ? supported('timeZone') : FALLBACK;
  } catch {
    ids = FALLBACK;
  }
  if (!ids.includes('UTC')) ids = [...ids, 'UTC'];

  return ids
    .map((id) => {
      const offset = offsetMinutes(id, at);
      // «Europe/Moscow» → «Москва…», «America/New_York» → «New York», «UTC» → «UTC»
      const name = RU_NAMES[id] ?? (id.split('/').slice(1).join(' / ').replace(/_/g, ' ') || id);
      return { id, offset, label: `(UTC${formatOffset(offset)}) ${name}` };
    })
    .sort((a, b) => a.offset - b.offset || a.label.localeCompare(b.label, 'ru'));
}

/** Пояс из настроек компьютера — им заполняем поле по кнопке. */
export function browserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch { return 'UTC'; }
}
