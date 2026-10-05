import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { api } from '../lib/api';
import { compareVersions, mobileConfig, MobileConfig, setMobileConfig } from '../lib/mobile-config';
import { isNativeShell, platform } from '../platform';
import { toastSaved } from '../lib/notifications';

/** Открыть окно установки обновления (его держит App через useMobileConfig). */
export const UPDATE_OPEN_EVENT = 'teamcrm:update-open';

function day(iso: string | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });
}

/**
 * «Приложение» в панели разделов — только в приложении на телефоне (просьба заказчика).
 *
 * Видно, какая версия стоит и какой последний выпуск с датой. Кнопка одна и меняется
 * по положению дел: стоит последняя — «Обновить» (проверить, не вышло ли новое);
 * вышла новая, а у человека старая — «Запустить обновление» (скачать и поставить).
 * Раньше узнать о новой версии можно было только из окна, которое само всплывает
 * при запуске, — закрыл его, и до следующего запуска о нём не вспомнить.
 */
export function AppUpdateRow() {
  const [release, setRelease] = useState<MobileConfig['android']>(() => mobileConfig()?.android ?? null);
  const [busy, setBusy] = useState(false);
  const installed = platform.info().nativeVersion;

  // конфиг мог прийти уже после первой отрисовки — подхватываем
  useEffect(() => {
    if (release) return;
    const t = window.setInterval(() => {
      const r = mobileConfig()?.android;
      if (r) { setRelease(r); window.clearInterval(t); }
    }, 2000);
    return () => window.clearInterval(t);
  }, [release]);

  if (!isNativeShell()) return null;

  const behind = !!release && !!installed && compareVersions(installed, release.latestNative) < 0;

  const check = async () => {
    setBusy(true);
    try {
      const c = await api.mobileConfig();
      setMobileConfig(c);
      setRelease(c.android);
      const newer = !!c.android && !!installed && compareVersions(installed, c.android.latestNative) < 0;
      if (newer) window.dispatchEvent(new Event(UPDATE_OPEN_EVENT));
      else toastSaved('У вас последняя версия', `ANTHILL ${installed ?? ''}`.trim());
    } catch {
      toastSaved('Не удалось проверить обновления', 'Проверьте связь и попробуйте ещё раз');
    } finally { setBusy(false); }
  };

  return (
    <div className="app-update-row">
      <div className="app-update-text">
        <span className="app-update-title"><Icon name="download" size={14} /> Приложение {installed ?? ''}</span>
        <span className="dim">
          {release
            ? `Последнее обновление: ${release.latestNative}${release.publishedAt ? ` от ${day(release.publishedAt)}` : ''}${behind ? ' — не установлено' : ' — установлено'}`
            : 'Проверяем, есть ли обновления…'}
        </span>
      </div>
      {behind ? (
        <button className="btn btn-primary btn-sm" onClick={() => window.dispatchEvent(new Event(UPDATE_OPEN_EVENT))}>
          Запуск обновления
        </button>
      ) : (
        <button className="btn btn-sm" onClick={() => void check()} disabled={busy}>
          {busy ? 'Проверяю…' : 'Обновить'}
        </button>
      )}
    </div>
  );
}
