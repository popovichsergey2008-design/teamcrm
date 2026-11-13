/**
 * #4902, п. 13: личное — не в протокол и не в риски.
 *
 * 11.11 в риски встречи попало «нет света, воды и отопления» — личная ситуация
 * сотрудника ушла в протокол, который читает вся команда и иногда клиент. Модели
 * сказано так не делать (правило ниже идёт в промпт), но модель ошибается, поэтому
 * готовый разбор проходит ещё и этот фильтр: формулировку о личном заменяем
 * нейтральной — «риск доступности исполнителя». Для сроков этого достаточно, а
 * подробности остаются между человеком и руководителем.
 */
import { maskSecrets } from './secrets';

export const NEUTRAL_AVAILABILITY = 'Риск доступности исполнителя';

/** Правило для промптов разбора встречи и сводок. */
export const PRIVACY_PROMPT_RULE =
  'Конфиденциальность: пароли, логины с паролями, токены, ключи и номера карт в ответ НЕ переписывай — ' +
  'вместо значения пиши «••••••». Личные обстоятельства людей (здоровье, семья, жильё и коммунальные ' +
  'проблемы вроде «нет света, воды и отопления», деньги, личная жизнь) в сводку, решения, риски и вопросы ' +
  'не включай. Если это влияет на сроки, напиши нейтрально: «риск доступности исполнителя» — без подробностей.';

/*
  Шаблоны личного. Основы слов — без \b: в JS \b не видит кириллицу. Шаблоны узкие
  намеренно: «операции с платежами», «разводка платы», «температура сервера» — работа,
  а не личное, и вычищать их из протокола нельзя.
*/
const PERSONAL: RegExp[] = [
  /(?:нет|отключил\p{L}*|отключ[её]н\p{L}*|без|пропал\p{L}*|дали|не было)\s+(?:ни\s+)?(?:света|воды|горячей воды|отоплени\p{L}*|электричеств\p{L}*|газа|тепла)/iu,
  /(?:света|электричества),?\s+(?:ни\s+)?воды\s+(?:и|,)\s+(?:ни\s+)?отоплени/iu,
  /(?<!\p{L})(?:болеет|заболел\p{L}*|болезн\p{L}*|больничн\p{L}*|на больничном|приболел\p{L}*|простыл\p{L}*|высок\p{L}* температур\p{L}*|с температурой)/iu,
  /(?<!\p{L})(?:в больниц\p{L}*|госпитализ\p{L}*|скор\p{L}* помощ\p{L}*|после операции|на операци\p{L}*|перен[её]с операци\p{L}*|к врачу|у врача)/iu,
  /(?<!\p{L})(?:похорон\p{L}*|умер(?:ла|ли)?(?!\p{L})|скончал\p{L}*|траур\p{L}*|погиб\p{L}*)/iu,
  /(?<!\p{L})(?:развод(?:ится|имся|ится|е|а|ом)?(?!\p{L})|беремен\p{L}*|в декрет\p{L}*|декретн\p{L}*|рожает|родила)/iu,
  /(?<!\p{L})(?:ребён\p{L}*|ребен\p{L}*|дет(?:и|ей|ям)|сын\p{L}*|доч(?:ь|ка|ери|ке)|жен[аеуы]|муж(?:ем|а|у)?|мам[аеуы]|пап[аеуы]|родител\p{L}*)\s+(?:болеет|заболел\p{L}*|в больниц\p{L}*|попал\p{L}* в больниц\p{L}*)/iu,
  /(?<!\p{L})(?:семейн\p{L}+|личн\p{L}+)\s+(?:обстоятельств\p{L}*|проблем\p{L}*|причин\p{L}*|ситуаци\p{L}*|дел\p{L}*)/iu,
  /(?<!\p{L})(?:депресси\p{L}*|психолог\p{L}*|психиатр\p{L}*|паническ\p{L}* атак\p{L}*)/iu,
  /(?<!\p{L})(?:соседи\s+)?(?:затопил\p{L}*|потоп\p{L}*|пожар\p{L}*)\s+(?:в\s+)?(?:квартир\p{L}*|дома|соседи)/iu,
  /(?<!\p{L})(?:дома|в квартир\p{L}*)\s+(?:авари\p{L}*|потоп|пожар|ремонт\p{L}*)/iu,
  /\b(?:sick leave|on sick|in hospital|hospitali[sz]ed|funeral|divorce|pregnan\w*|maternity leave|no (?:electricity|power|water|heating)|family emergency|personal reasons)\b/i,
];

export function isPersonalTopic(text: string | null | undefined): boolean {
  const s = String(text ?? '');
  return !!s && PERSONAL.some((re) => re.test(s));
}

/** Пункт риска или решения: о личном — нейтральная формулировка, иначе как есть. */
export function neutralizePersonal(text: string): string {
  return isPersonalTopic(text) ? NEUTRAL_AVAILABILITY : text;
}

/**
 * Сводка — связный текст: предложения о личном убираем целиком, а если такие были,
 * в конце одной фразой говорим о риске. Секреты — маской.
 */
export function cleanSummary(text: string): string {
  const masked = maskSecrets(String(text ?? ''));
  const sentences = masked.match(/[^.!?\n]+[.!?]*\s*|\n+/gu) ?? [masked];
  let dropped = false;
  const kept = sentences.filter((s) => {
    if (isPersonalTopic(s)) { dropped = true; return false; }
    return true;
  });
  if (!dropped) return masked;
  const body = kept.join('').trim();
  return `${body}${body && !/[.!?]$/.test(body) ? '.' : ''}${body ? ' ' : ''}Есть ${NEUTRAL_AVAILABILITY.toLowerCase()}.`;
}

interface Sourced { text: string }

/**
 * Готовый разбор встречи перед сохранением: секреты — маской везде, личное — вон из
 * сводки, решений, вопросов и рисков. Решение или вопрос о личном выбрасываем (это не
 * решение по работе), а в риски кладём одну нейтральную строку — сроки она объясняет.
 */
export function guardProtocol<T extends {
  summary: string;
  decisions: Sourced[];
  risks: string[];
  questions: Sourced[];
  tasks: Array<{ title: string; description: string | null; quote: string | null }>;
}>(value: T): T {
  let personal = false;
  const keep = <S extends Sourced>(list: S[]): S[] => list
    .filter((d) => { if (isPersonalTopic(d.text)) { personal = true; return false; } return true; })
    .map((d) => ({ ...d, text: maskSecrets(d.text) }));
  value.summary = cleanSummary(value.summary);
  value.decisions = keep(value.decisions);
  value.questions = keep(value.questions);
  const risks = value.risks.map((r) => {
    if (isPersonalTopic(r)) { personal = true; return NEUTRAL_AVAILABILITY; }
    return maskSecrets(r);
  });
  if (personal && !risks.includes(NEUTRAL_AVAILABILITY)) risks.push(NEUTRAL_AVAILABILITY);
  value.risks = [...new Set(risks)];
  for (const t of value.tasks) {
    t.title = maskSecrets(t.title);
    t.description = maskSecrets(t.description) ?? null;
    t.quote = maskSecrets(t.quote) ?? null;
  }
  return value;
}
