import { useEffect, useMemo, useState } from 'react';
import qrcode from 'qrcode-generator';
import { ApiError, request } from '../lib/api';
import { notificationPermission, requestNotificationPermission } from '../lib/notifications';
import { navigate } from '../lib/router';
import { Icon } from './Icon';

interface Modes { mode: 'important' | 'all'; quietFrom: string | null; quietTo: string | null; telegramAll: boolean; timezone: string; telegram: boolean; phones: number }

/**
 * Уведомления доходят, но не шумят (#4902, п. 1): каналы доставки — браузер, Telegram
 * (только важное), телефон (QR); режим «Только важное» по умолчанию: упоминания, личные
 * сообщения, звонки, вопросы к вам, срок задачи сегодня — остальное в «Что я пропустил»;
 * тихие часы — по поясу человека.
 */
export function NotifyChannels() {
  const [m, setM] = useState<Modes | null>(null);
  const [perm, setPerm] = useState(notificationPermission());
  const [err, setErr] = useState('');
  const [qr, setQr] = useState(false);
  useEffect(() => { void request<Modes>('GET', '/me/notify-modes').then(setM).catch(() => undefined); }, []);
  const save = async (p: Partial<Modes>) => {
    setErr('');
    try { setM(await request<Modes>('PUT', '/me/notify-modes', p)); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };
  const appUrl = `${window.location.origin}/get`;
  const svg = useMemo(() => {
    if (!qr) return '';
    const q = qrcode(0, 'M'); q.addData(appUrl); q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [qr, appUrl]);
  if (!m) return null;
  const tz = m.timezone === 'Europe/Moscow' ? 'МСК' : m.timezone;
  return (
    <div className="drawer-section">
      <div className="drawer-section-title">Куда и что приходит</div>
      <label className="notify-row">
        <span>Режим</span>
        <select className="ui-input ui-input-sm" style={{ marginLeft: 'auto', maxWidth: 200, flex: 'none' }} value={m.mode}
          onChange={(e) => void save({ mode: e.target.value as Modes['mode'] })} aria-label="Режим уведомлений">
          <option value="important">Только важное</option>
          <option value="all">Всё</option>
        </select>
      </label>
      <div className="dim" style={{ fontSize: 12, margin: '2px 0 8px' }}>
        {m.mode === 'important'
          ? 'Сразу — упоминания, личные сообщения, звонки, вопросы к вам и срок задачи сегодня. Остальное — во «Входящих» и в сводке «Что я пропустил».'
          : 'Push о каждом сообщении во всех чатах.'}
      </div>
      <div className="notify-row">
        <span><Icon name="bell" size={14} /> Браузер</span>
        <span style={{ marginLeft: 'auto' }}>
          {perm === 'granted' ? <span className="dim">включено</span>
            : perm === 'default' ? <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={async () => setPerm(await requestNotificationPermission())}>Включить</button>
              : perm === 'denied' ? <span className="dim" style={{ fontSize: 12 }}>запрещено: замок слева от адреса → «Уведомления» → «Разрешить»</span>
                : <span className="dim">не поддерживается</span>}
        </span>
      </div>
      <div className="notify-row">
        <span><Icon name="send" size={14} /> Telegram</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          {m.telegram ? (
            <label className="dim" style={{ fontSize: 12 }}>
              <input type="checkbox" checked={!m.telegramAll} onChange={(e) => void save({ telegramAll: !e.target.checked })} /> только важное
            </label>
          ) : <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => navigate({ section: 'settings' })}>Подключить</button>}
        </span>
      </div>
      <div className="notify-row">
        <span><Icon name="phone" size={14} /> Телефон</span>
        <span style={{ marginLeft: 'auto' }}>
          {m.phones ? <span className="dim">подключён</span> : <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" aria-expanded={qr} onClick={() => setQr((v) => !v)}>QR-код</button>}
        </span>
      </div>
      {qr && (
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', margin: '6px 0' }}>
          <span style={{ width: 120, height: 120, background: '#fff', borderRadius: 8, display: 'inline-block' }} dangerouslySetInnerHTML={{ __html: svg }} />
          <span className="dim" style={{ fontSize: 12 }}>Наведите камеру телефона — откроется страница приложения QEVO. Звонки дойдут, даже когда вкладка закрыта.</span>
        </div>
      )}
      <div className="notify-row">
        <span>Тихие часы ({tz})</span>
        <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <input className="ui-input ui-input-sm" type="time" value={m.quietFrom ?? ''} aria-label="Тихие часы с" style={{ width: 110 }}
            onChange={(e) => void save({ quietFrom: e.target.value || null })} />
          —
          <input className="ui-input ui-input-sm" type="time" value={m.quietTo ?? ''} aria-label="Тихие часы до" style={{ width: 110 }}
            onChange={(e) => void save({ quietTo: e.target.value || null })} />
        </span>
      </div>
      <div className="dim" style={{ fontSize: 12 }}>{m.quietFrom && m.quietTo ? `С ${m.quietFrom} до ${m.quietTo} по вашему времени уведомления молчат — всё ляжет во «Входящие».` : 'Не заданы — уведомления приходят в любое время.'}</div>
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
