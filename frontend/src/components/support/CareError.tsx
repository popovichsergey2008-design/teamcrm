import { useEffect, useState } from 'react';
import { diag, flushDiag } from '../../lib/diag';
import { noteSupportError } from '../../lib/support-context';
import { openSupport } from './SupportDock';

/**
 * Экран технической ошибки или обрыва связи (ТЗ-34, «Сегодня» 5.2) — вместо сухих кодов.
 *
 * Тексты — дословно по документу. «Лог уже получил» — не фигура речи: сбой уходит в
 * журнал диагностики сразу при показе, а кнопка заводит обращение сама, с ошибкой и
 * контекстом экрана. Без связи — подключим, как только она вернётся.
 */
export default function CareError({ error, offline = false }: { error?: string; offline?: boolean }) {
  const [waiting, setWaiting] = useState(false);

  useEffect(() => {
    if (!error) return;
    noteSupportError(error);
    diag('app', offline ? 'net.lost' : 'screen.crash', window.location.pathname, { error: error.slice(0, 300) });
    flushDiag();
  }, [error, offline]);

  const ask = () => {
    const text = offline
      ? 'Пропала связь с сервером — подключитесь, пожалуйста, к моему экрану.'
      : `Экран не загрузился${error ? `: ${error.slice(0, 200)}` : ''}. Подключитесь, пожалуйста, к моему экрану.`;
    if (navigator.onLine === false) {
      setWaiting(true);
      const go = () => { window.removeEventListener('online', go); setWaiting(false); openSupport(undefined, { text }); };
      window.addEventListener('online', go);
      return;
    }
    openSupport(undefined, { text });
  };

  return (
    <div className="screen-crash-card">
      <h2>Мы уже видим эту заминку в телеметрии и чиним ее!</h2>
      <p className="dim">
        В Qevo вам никогда не придется делать скриншоты, чистить кэш или ждать ответа по 3 дня. Дежурный разработчик уже получил лог и правит код. Нажмите кнопку ниже, чтобы инженер подключился в этот экран за 15 секунд с готовым решением.
      </p>
      <div className="screen-crash-actions">
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={ask} disabled={waiting}>
          Подключить инженера за 15 секунд
        </button>
        {!offline && (
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => window.location.reload()}>Обновить</button>
        )}
      </div>
      {waiting && <p className="dim">Связи пока нет — подключим инженера, как только она появится.</p>}
    </div>
  );
}
