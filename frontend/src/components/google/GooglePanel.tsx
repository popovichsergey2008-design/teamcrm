import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { Button } from '../ui/button';
import { Checkbox } from '../ui/checkbox';
import { Select } from '../ui/select';
import { confirmAction } from '../ui/dialog';
import { ApiError } from '../../lib/api';
import { overlayProps } from '../../lib/overlay';
import { agoLabel } from '../../lib/presence';
import { connectGoogle, google, GoogleCalendarSettings, GoogleStatus } from '../../lib/google';
import { GoogleMark } from './GoogleFilesBlock';
import './google.css';

/** Что вернул Google после экрана согласия — словами (?google=… в адресе). */
const RESULT: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'Google подключён' },
  denied: { ok: false, text: 'Вы не дали доступ на экране Google — ничего не подключено' },
  expired: { ok: false, text: 'Подключение устарело — нажмите «Подключить» ещё раз' },
  error: { ok: false, text: 'Google не подключился. Попробуйте ещё раз; если повторится — напишите в службу заботы' },
};

/**
 * «Настройки → Google» (#1565, §36, §99, §105): какой аккаунт подключён, какие
 * сервисы разрешены, куда класть встречи и как всё отключить.
 *
 * Подключение личное: каждый сотрудник даёт доступ к своему Google и видит здесь только своё.
 */
export function GooglePanel({ onClose }: { onClose: () => void }) {
  const [status, setStatus] = useState<GoogleStatus | null>(null);
  const [cal, setCal] = useState<GoogleCalendarSettings | null>(null);
  const [calendars, setCalendars] = useState<{ id: string; title: string; primary: boolean }[]>([]);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [notice, setNotice] = useState('');
  const [result] = useState(() => new URLSearchParams(window.location.search).get('google'));

  const load = useCallback(async () => {
    const s = await google.status().catch(() => null);
    setStatus(s);
    if (s?.account?.calendar && s.account.status === 'active') {
      google.calendarSettings().then(setCal).catch(() => undefined);
      google.calendars().then(setCalendars).catch(() => undefined);
    }
  }, []);
  useEffect(() => {
    void load();
    // убираем ?google=… из адреса: при обновлении страницы «подключено» не должно всплывать снова
    if (result) window.history.replaceState(window.history.state, '', window.location.pathname);
    // подключали в системном браузере (приложение) — вернулись, перечитали
    const onFocus = () => void load();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [load, result]);

  const fail = (e: unknown, fallback: string) => setErr(e instanceof ApiError ? e.message : fallback);
  const connect = (service: 'drive' | 'calendar' | 'all') => {
    setErr(''); setBusy(service);
    connectGoogle(service, '/settings/google').catch((e) => { fail(e, 'Не удалось открыть Google'); setBusy(''); });
  };
  const disconnect = async () => {
    if (!(await confirmAction({
      title: 'Отключить Google?',
      description: 'Встречи QEVO уберутся из вашего Google Календаря, а встречи Google — из календаря QEVO. Прикреплённые файлы останутся ссылками и в Google никуда не денутся.',
      confirmLabel: 'Отключить',
      danger: true,
    }))) return;
    setBusy('off');
    await google.disconnect().catch((e) => fail(e, 'Не удалось отключить'));
    setCal(null); setCalendars([]); setBusy('');
    void load();
  };
  const saveCal = async (patch: Parameters<typeof google.saveCalendarSettings>[0]) => {
    setErr(''); setBusy('cal');
    try { setCal(await google.saveCalendarSettings(patch)); }
    catch (e) { fail(e, 'Не удалось сохранить'); }
    finally { setBusy(''); }
  };
  const syncNow = async () => {
    setErr(''); setNotice(''); setBusy('sync');
    try {
      const r = await google.syncCalendar();
      setCal((c) => (c ? { ...c, lastPullAt: new Date().toISOString(), lastError: null } : c));
      window.setTimeout(() => void google.calendarSettings().then(setCal).catch(() => undefined), 1500);
      setNotice(`Готово: в Google — ${r.pushed}, из Google обновлено — ${r.pulled}`);
    } catch (e) { fail(e, 'Синхронизация не удалась'); }
    finally { setBusy(''); }
  };

  const acc = status?.account;
  const res = result ? RESULT[result] : null;

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><GoogleMark size={18} /> Google</h3>
          <button className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="anthill-pane gset">
          <p className="gset-dim">
            Подключите свой Google — и работайте с ним прямо в QEVO: прикрепляйте файлы с Диска к задачам, проектам,
            клиентам и встречам, создавайте Google-документы с данными из QEVO, держите встречи в Google Календаре.
            Подключение личное: доступ получаете только вы, к своему Google.
          </p>

          {res && <div className={res.ok ? 'gset-ok' : 'gset-warn'} role="status">{res.ok && <Icon name="check" size={14} />} {res.text}</div>}
          {status && !status.configured && (
            <div className="gset-warn">Интеграция с Google пока не настроена на сервере — её включит администратор QEVO.</div>
          )}

          {acc && (
            <div className="gset-card">
              <h4><Icon name="user" size={16} /> {acc.email}</h4>
              {acc.status === 'attention' ? (
                <div className="gset-warn">
                  Google отозвал доступ{acc.lastError ? ` (${acc.lastError})` : ''}. Подключите заново — файлы и настройки сохранятся.
                </div>
              ) : (
                <p className="gset-dim">Подключён {agoLabel(acc.connectedAt)}{acc.name ? ` · ${acc.name}` : ''}</p>
              )}
              <div className="gset-row">
                {acc.status === 'attention' && (
                  <Button size="sm" variant="primary" onClick={() => connect('all')} loading={busy === 'all'}>Подключить заново</Button>
                )}
                <Button size="sm" variant="outline" onClick={disconnect} loading={busy === 'off'}>Отключить Google</Button>
              </div>
            </div>
          )}

          {status?.configured && (
            <>
              <div className="gset-card">
                <h4><Icon name="folder" size={16} /> Google Диск и Документы</h4>
                {acc?.drive && acc.status === 'active' ? (
                  <>
                    <span className="gset-ok"><Icon name="check" size={14} /> Подключено</span>
                    <ul className="gset-list">
                      <li>В задаче — вкладка «Файлы», в проекте — Инфоцентр, у клиента — «Файлы», у встречи — её карточка.</li>
                      <li>«Прикрепить с Диска» открывает окно Google: QEVO видит только выбранные вами файлы, а не весь Диск.</li>
                      <li>Кнопка документа создаёт Google-документ с данными: задача, проект, итоги для клиента, протокол встречи.</li>
                    </ul>
                  </>
                ) : (
                  <>
                    <p className="gset-dim">QEVO получит доступ только к файлам, которые вы сами выберете в окне Google, и к документам, которые создаст.</p>
                    <div className="gset-row">
                      <Button size="sm" variant="primary" onClick={() => connect(acc ? 'drive' : 'all')} loading={busy === 'drive' || busy === 'all'}>
                        {acc ? 'Разрешить Диск' : 'Подключить Google'}
                      </Button>
                    </div>
                  </>
                )}
              </div>

              <div className="gset-card">
                <h4><Icon name="calendar" size={16} /> Google Календарь</h4>
                {acc?.calendar && acc.status === 'active' ? (
                  <>
                    <span className="gset-ok"><Icon name="check" size={14} /> Подключено</span>
                    {calendars.length > 0 && (
                      <label className="gset-row">
                        <span className="gset-dim">Класть встречи в</span>
                        <Select
                          ariaLabel="Календарь Google для встреч"
                          size="sm"
                          value={cal?.calendarId ?? 'primary'}
                          disabled={busy === 'cal'}
                          onValueChange={(v) => void saveCal({ calendarId: v, calendarTitle: calendars.find((c) => c.id === v)?.title })}
                          options={calendars.map((c) => ({ value: c.id, label: c.primary ? `${c.title} (основной)` : c.title }))}
                        />
                      </label>
                    )}
                    <Checkbox
                      checked={cal?.pushMeetings ?? true}
                      disabled={busy === 'cal'}
                      onCheckedChange={(v) => void saveCal({ pushMeetings: v })}
                      label="Мои встречи QEVO — в Google Календарь (без писем участникам: приглашения уже шлёт QEVO)"
                    />
                    <Checkbox
                      checked={cal?.pullEvents ?? true}
                      disabled={busy === 'cal'}
                      onCheckedChange={(v) => void saveCal({ pullEvents: v })}
                      label="Встречи из Google — видны в календаре QEVO (только для чтения: чтобы не назначать на занятое время)"
                    />
                    {cal?.lastError && <div className="gset-warn">{cal.lastError}</div>}
                    <div className="gset-row">
                      <Button size="sm" variant="outline" onClick={syncNow} loading={busy === 'sync'}>
                        <Icon name="refresh" size={14} /> Синхронизировать сейчас
                      </Button>
                      <span className="gset-dim">{cal?.lastPullAt ? `обновлено ${agoLabel(cal.lastPullAt)} · сама — раз в 10 минут` : 'сама — раз в 10 минут'}</span>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="gset-dim">Встречи QEVO появятся в вашем Google Календаре и будут меняться вместе с ними, а встречи из Google — видны в QEVO.</p>
                    <div className="gset-row">
                      <Button size="sm" variant="primary" onClick={() => connect(acc ? 'calendar' : 'all')} loading={busy === 'calendar'}>
                        {acc ? 'Разрешить Календарь' : 'Подключить Google'}
                      </Button>
                    </div>
                  </>
                )}
              </div>
            </>
          )}

          {notice && <p className="gfiles-ok" role="status"><Icon name="check" size={13} /> {notice}</p>}
          {err && <p className="gfiles-err" role="alert">{err}</p>}
        </div>
      </aside>
    </div>
  );
}
