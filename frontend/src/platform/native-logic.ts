/**
 * Чистые правила нативной оболочки (ТЗ-34): текст хода работы службы заботы и выбор
 * веб-бандла для обновления по воздуху. Отдельно от `capacitor.ts`, чтобы их проверял
 * `npm run check` без плагинов Capacitor.
 */

/** Что прислало окно заботы событием `qevo:care-progress`. */
export interface CareProgress {
  engineer?: string | null;
  text?: string | null;
  percent: number;
  minutesLeft?: number | null;
}

/** Уведомление на экране блокировки: заголовок, строка, процент; done — «Готово» вместо полосы. */
export function careNotification(p: CareProgress): { title: string; text: string; percent: number; done: boolean } {
  const percent = Math.max(0, Math.min(100, Math.round(Number(p.percent) || 0)));
  const who = `Инженер${p.engineer?.trim() ? ` ${p.engineer.trim()}` : ''}`;
  const doing = p.text?.trim() ? ` ${p.text.trim()}` : '';
  if (percent >= 100) return { title: 'Готово', text: `${who}${doing}: готово 100%`, percent: 100, done: true };
  const left = p.minutesLeft != null && p.minutesLeft > 0 ? ` (осталось ${Math.ceil(p.minutesLeft)} мин)` : '';
  return {
    title: 'Служба заботы',
    text: `${who}${doing}: готово ${percent}%${left}. Пришлем тихий пуш по готовности`,
    percent,
    done: false,
  };
}

/** Манифест бандла с сервера (`/mobile/bundle`). */
export interface BundleManifest {
  version: string;
  minNative: string;
  url: string;
  sha256: string;
  mandatory?: boolean;
  signature?: string;
}

/** Числа по порядку: 1.10 > 1.9; «2026.10.22.1430-abc1234» сравнивается по части до «-». */
function nums(v: string | null | undefined): number[] {
  return String(v ?? '').split('-')[0].split(/[^0-9]+/).filter(Boolean).map(Number);
}
export function compareVersionKeys(a: string | null | undefined, b: string | null | undefined): number {
  const x = nums(a); const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

const OUR_URL = /^https:\/\/(?:[a-z0-9-]+\.)?(?:qevo\.one|anthill\.team)\//i;

/**
 * Качать ли бандл из манифеста. Нет — если он уже идёт или уже скачан, помечен битым,
 * не с нашего домена, требует оболочку новее или старше того, что идёт сейчас (откат
 * на старый — только если техотдел объявил его обязательным).
 */
export function shouldFetchBundle(
  m: BundleManifest | null | undefined,
  s: { running: string; native: string; bad: string[]; pending: string | null; stable: string | null },
): boolean {
  if (!m?.version || !m.sha256 || !OUR_URL.test(m.url ?? '')) return false;
  if (m.version === s.running || m.version === s.pending || s.bad.includes(m.version)) return false;
  if (!/\d/.test(s.native) || compareVersionKeys(s.native, m.minNative) < 0) return false;
  if (!m.mandatory && compareVersionKeys(m.version, s.running) <= 0) return false;
  return true;
}
