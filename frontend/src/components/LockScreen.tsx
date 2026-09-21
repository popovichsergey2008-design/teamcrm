import { useEffect, useState } from 'react';
import { Logo } from './Logo';
import { platform } from '../platform';

/**
 * Экран блокировки (ТЗ-9): приложение свернули надолго — при возврате просим
 * Face ID / отпечаток. Пока не разблокировали, содержимого не видно.
 *
 * Первая попытка — сама, без нажатия: человек открыл приложение и уже ждёт запрос.
 * Не получилось (отменил, не распознало) — кнопка «Разблокировать» для повтора.
 */
export function LockScreen({ onUnlock }: { onUnlock: () => void }) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const attempt = async () => {
    setBusy(true); setFailed(false);
    const ok = await platform.biometrics.authenticate('Разблокировать ANTHILL');
    setBusy(false);
    if (ok) onUnlock(); else setFailed(true);
  };
  // Одна автоматическая попытка при появлении экрана; дальше — по кнопке.
  useEffect(() => {
    void attempt();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="lock-screen" role="dialog" aria-modal="true" aria-label="Приложение заблокировано">
      <Logo size={56} />
      <b className="lock-title">ANTHILL заблокирован</b>
      <span className="dim">{failed ? 'Не удалось подтвердить — попробуйте ещё раз' : 'Подтвердите, что это вы'}</span>
      <button className="btn btn-primary" disabled={busy} onClick={() => void attempt()}>
        {busy ? 'Проверяем…' : 'Разблокировать'}
      </button>
    </div>
  );
}