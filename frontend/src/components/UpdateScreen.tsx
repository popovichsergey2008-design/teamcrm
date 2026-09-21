import { Logo } from './Logo';
import { platform } from '../platform';
import type { MobileConfig } from '../lib/mobile-config';

/**
 * Обязательное обновление (ТЗ-9): версия оболочки ниже минимальной, и работать
 * с ней сервер не будет — например, сменился протокол. Одна кнопка: скачать APK.
 * Только для критичных случаев (D-08 пакета); обычное обновление — всплывашкой.
 */
export function UpdateScreen({ release }: { release: NonNullable<MobileConfig['android']> }) {
  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="Нужно обновить приложение">
      <Logo size={56} />
      <b className="lock-title">Нужно обновить приложение</b>
      <span className="dim">
        Версия {platform.info().nativeVersion ?? '—'} больше не поддерживается. Скачайте {release.latestNative} — это минута.
      </span>
      {release.notes && <span className="dim">{release.notes}</span>}
      <button className="btn btn-primary" onClick={() => platform.openExternal(release.apkUrl)}>Скачать обновление</button>
    </div>
  );
}