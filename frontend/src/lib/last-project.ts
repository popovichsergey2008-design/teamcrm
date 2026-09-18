/**
 * Последняя доска, на которой человек работал.
 *
 * Зачем: «Проекты и доски» открываются там, где работу оставили, а не на таблице всех
 * проектов. Человек весь день сидит в одном проекте — заставлять его каждый раз
 * выбирать его заново значит добавлять лишний шаг к каждому возвращению.
 *
 * Почему кука, а не localStorage: у памяти есть срок. Проект «тот самый» ровно пока
 * идёт работа над ним; через неделю это уже чужой выбор, сделанный за человека. Кука с
 * `max-age` истекает сама — срок хранится вместе со значением, а не проверяется кодом,
 * который легко забыть написать.
 *
 * Вместе с номером проекта храним организацию: у человека их может быть несколько, и
 * вернуть его в чужой проект хуже, чем не вернуть никуда.
 */

const NAME = 'anthill.lastProject';
/** Сутки: рабочий день кончается, память о нём — тоже. */
const TTL_SEC = 24 * 60 * 60;

function read(): string | null {
  try {
    const hit = document.cookie.split('; ').find((c) => c.startsWith(`${NAME}=`));
    return hit ? decodeURIComponent(hit.slice(NAME.length + 1)) : null;
  } catch {
    return null; // куки выключены — просто работаем без памяти
  }
}

/** Запомнить доску на сутки. */
export function rememberProject(tenantId: string | undefined, projectId: string | null): void {
  if (!tenantId || !projectId) return;
  try {
    const value = encodeURIComponent(`${tenantId}:${projectId}`);
    document.cookie = `${NAME}=${value}; max-age=${TTL_SEC}; path=/; SameSite=Lax`;
  } catch { /* приватный режим — не беда */ }
}

/** Куда возвращать: номер доски или null, если память пуста, протухла или от другой организации. */
export function lastProject(tenantId: string | undefined): string | null {
  if (!tenantId) return null;
  const raw = read();
  if (!raw) return null;
  const [tenant, projectId] = raw.split(':');
  return tenant === String(tenantId) && projectId ? projectId : null;
}

/**
 * Забыть доску.
 *
 * Зовётся, когда человек ПОПРОСИЛ список всех проектов: иначе «Все проекты» тут же
 * отбрасывало бы его обратно в доску, из которой он только что вышел.
 */
export function forgetProject(): void {
  try {
    document.cookie = `${NAME}=; max-age=0; path=/; SameSite=Lax`;
  } catch { /* нечего забывать */ }
}
