import { useEffect, useRef, useState } from 'react';
import { BottomSheet } from './BottomSheet';
import { Logo } from './Logo';
import { Icon } from './Icon';
import { humanSize } from '../lib/attachments';
import { platform } from '../platform';
import type { MobileConfig } from '../lib/mobile-config';

/**
 * Обновление приложения одним нажатием (просьба заказчика).
 *
 * Магазинов у нас нет намеренно, и до сих пор обновление выглядело так: всплывашка со
 * ссылкой → браузер → скачать файл → найти его в загрузках → разрешить установку →
 * нажать. Люди застревали на этом пути и месяцами сидели на старой сборке, а потом
 * жаловались на давно починенное. Теперь приложение само качает выпуск, сверяет его
 * с контрольной суммой и отдаёт системному установщику.
 *
 * Чего мы НЕ делаем намеренно: не ставим обновление молча. Показывает и спрашивает
 * система — человек должен видеть, что именно ставится, иначе это ничем не отличается
 * от подмены приложения.
 *
 * Где оболочка так не умеет (браузер, iOS) — остаётся прежняя честная ссылка.
 */
export function UpdateSheet({ release, required, onClose }: {
  release: NonNullable<MobileConfig['android']>;
  /** Без обновления приложение не работает: «Позже» не предлагаем. */
  required?: boolean;
  onClose: () => void;
}) {
  const [self, setSelf] = useState<boolean | null>(null);
  const [state, setState] = useState<'ask' | 'loading' | 'installing' | 'permission' | 'failed'>('ask');
  const [share, setShare] = useState(0);
  /** Человек ушёл в системную настройку разрешения — по возвращении продолжаем сами. */
  const awaitingPermission = useRef(false);
  /** Установщик уже открывали: кнопка зовёт его снова, а не «Обновить» с нуля. */
  const [opened, setOpened] = useState(false);
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    let alive = true;
    void platform.appUpdate.canInstall().then((can) => { if (alive) setSelf(can); });
    return () => { alive = false; };
  }, []);

  /*
    Возврат в приложение.

    Android (Xiaomi, Samsung и другие) нередко спрашивает разрешение «устанавливать из
    этого источника» уже ПОСЛЕ открытия установщика: человек разрешает, жмёт «назад» —
    и попадает не в установщик, а к нам. Раньше здесь висела неактивная кнопка «Установка
    открыта», и сделать было нечего (жалоба заказчика). Теперь: вернулся после разрешения
    и разрешил — ставим сами; вернулся из установщика — кнопка снова активна и откроет
    его заново (файл уже скачан и проверен, повторно не качаем).
  */
  useEffect(() => {
    const onBack = () => {
      if (document.visibilityState !== 'visible') return;
      if (awaitingPermission.current) {
        void platform.appUpdate.permitted().then((ok) => {
          if (!ok) return; // не разрешил — остаётся кнопка «Разрешить установку»
          awaitingPermission.current = false;
          void download();
        });
        return;
      }
      if (stateRef.current === 'installing') setState('ask');
    };
    document.addEventListener('visibilitychange', onBack);
    window.addEventListener('focus', onBack);
    return () => {
      document.removeEventListener('visibilitychange', onBack);
      window.removeEventListener('focus', onBack);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const download = async () => {
    if (stateRef.current === 'loading') return;
    setState('loading'); setShare(0);
    const result = await platform.appUpdate.install(
      { url: release.apkUrl, sha256: release.sha256, version: release.latestNative },
      setShare,
    );
    if (result === 'installing') { setOpened(true); setState('installing'); return; }
    if (result === 'needs_permission') { setState('permission'); return; }
    if (result === 'unsupported') { setSelf(false); setState('ask'); return; }
    setState('failed');
  };

  const allow = async () => {
    awaitingPermission.current = true;
    await platform.appUpdate.requestInstallPermission();
    // Человек уходит в настройки системы; вернётся с разрешением — установка продолжится сама.
  };

  const body = (
    <div className="update-body">
      <div className="update-head">
        <span className="update-badge"><Icon name="download" size={18} /></span>
        <div>
          <b>Версия {release.latestNative}</b>
          <div className="dim update-size">
            {required ? 'Старая версия больше не работает с сервером' : 'Готова к установке'}
            {release.sizeBytes ? ` · ${humanSize(release.sizeBytes)}` : ''}
          </div>
        </div>
      </div>

      {release.notes && <p className="update-notes">{release.notes}</p>}

      {state === 'loading' && (
        <div className="update-progress" role="progressbar" aria-label="Загрузка обновления" aria-valuenow={Math.round(share * 100)}>
          <span style={{ width: `${Math.max(3, Math.round(share * 100))}%` }} />
        </div>
      )}
      {state === 'loading' && <div className="dim">Скачиваем… {Math.round(share * 100)}%</div>}

      {state === 'installing' && (
        <div className="dim">
          Файл проверен, открылось окно установки. Нажмите в нём «Обновить» — данные и вход сохранятся.
        </div>
      )}
      {state === 'ask' && opened && (
        <div className="dim">
          Окно установки закрылось? Так бывает, если Android сначала спрашивал разрешение. Нажмите
          «Установить» — оно откроется снова, файл уже скачан.
        </div>
      )}

      {state === 'permission' && (
        <div className="dim">
          Android спрашивает разрешение ставить обновления из приложения — иначе поставить себя мы не можем.
          Разрешите и нажмите «Обновить» ещё раз.
        </div>
      )}

      {state === 'failed' && (
        <div className="dim">
          Скачать не удалось: проверьте связь. Можно взять файл через браузер — приложение от этого не пострадает.
        </div>
      )}

      <div className="update-actions">
        {self === false || state === 'failed' ? (
          <button className="btn btn-primary" onClick={() => platform.openExternal(release.apkUrl)}>
            Скачать в браузере
          </button>
        ) : state === 'permission' ? (
          <button className="btn btn-primary" onClick={() => void allow()}>Разрешить установку</button>
        ) : (
          /* Кнопка не замирает никогда: если окно установки потерялось, её нажимают снова. */
          <button className="btn btn-primary" onClick={() => void download()} disabled={state === 'loading'}>
            {state === 'installing' ? 'Открыть установку ещё раз' : opened ? 'Установить' : 'Обновить'}
          </button>
        )}
        {!required && state !== 'loading' && (
          <button className="btn btn-ghost" onClick={onClose}>Позже</button>
        )}
      </div>
    </div>
  );

  /*
    Обязательное обновление — не лист поверх работы, а единственное, что видно: закрывать
    его нечем, за ним всё равно нерабочее приложение.
  */
  if (required) {
    return (
      <div className="lock-screen" role="dialog" aria-modal="true" aria-label="Нужно обновить приложение">
        <Logo size={56} />
        <b className="lock-title">Нужно обновить приложение</b>
        {body}
      </div>
    );
  }

  return (
    <BottomSheet title="Доступно обновление" onClose={state === 'loading' ? () => undefined : onClose}>
      {body}
    </BottomSheet>
  );
}
