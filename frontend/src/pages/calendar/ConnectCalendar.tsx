import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icon';
import { Dialog } from '../../components/ui/dialog';
import { api, ApiError } from '../../lib/api';
import { connectGoogle } from '../../lib/google';
import { toastSaved } from '../../lib/notifications';
import { calApi, CalPrefs, WeekAssistant } from './cal-api';

const ZONES: [string, string][] = [
  ['Europe/Kaliningrad', 'Калининград (UTC+2)'], ['Europe/Moscow', 'МСК (UTC+3)'], ['Europe/Samara', 'Самара (UTC+4)'],
  ['Asia/Yekaterinburg', 'Екатеринбург (UTC+5)'], ['Asia/Omsk', 'Омск (UTC+6)'], ['Asia/Novosibirsk', 'Новосибирск (UTC+7)'],
  ['Asia/Krasnoyarsk', 'Красноярск (UTC+7)'], ['Asia/Irkutsk', 'Иркутск (UTC+8)'], ['Asia/Yakutsk', 'Якутск (UTC+9)'],
  ['Asia/Vladivostok', 'Владивосток (UTC+10)'], ['Asia/Magadan', 'Магадан (UTC+11)'], ['Asia/Kamchatka', 'Камчатка (UTC+12)'],
  ['Europe/Minsk', 'Минск (UTC+3)'], ['Asia/Almaty', 'Алматы (UTC+5)'], ['Asia/Tashkent', 'Ташкент (UTC+5)'],
];
const zoneName = (tz: string) => ZONES.find(([z]) => z === tz)?.[1] ?? tz;

/** Рабочие часы, обед и пояс одной строкой — «изменить» раскрывает поля на месте. */
export function HoursLine({ prefs, onSaved }: { prefs: CalPrefs; onSaved: (p: CalPrefs) => void }) {
  const [edit, setEdit] = useState(false);
  const [f, setF] = useState({ workStart: prefs.workStart, workEnd: prefs.workEnd, lunchStart: prefs.lunchStart ?? '', lunchEnd: prefs.lunchEnd ?? '', timeZone: prefs.timeZone });
  const [err, setErr] = useState('');
  const save = async () => {
    setErr('');
    try {
      onSaved(await calApi.savePrefs({ workStart: f.workStart, workEnd: f.workEnd, lunchStart: f.lunchStart || null, lunchEnd: f.lunchEnd || null, timeZone: f.timeZone }));
      setEdit(false);
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не сохранилось'); }
  };
  if (!edit) {
    return (
      <div className="cal-hours-line dim">
        Рабочие часы: <b>{prefs.workStart}–{prefs.workEnd}</b>{prefs.lunchStart && prefs.lunchEnd ? <>, обед <b>{prefs.lunchStart}–{prefs.lunchEnd}</b></> : ', обед не указан'}
        {' · '}<button type="button" className="cal-link" onClick={() => setEdit(true)}>изменить</button>{' · '}часовой пояс {zoneName(prefs.timeZone)}
      </div>
    );
  }
  const t = (k: keyof typeof f) => (
    <input type="time" className="ui-input cal-time" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} aria-label={k} />
  );
  return (
    <div className="cal-hours-edit">
      <span>Работаю {t('workStart')}–{t('workEnd')}</span>
      <span>обед {t('lunchStart')}–{t('lunchEnd')}</span>
      <select className="ui-input" value={f.timeZone} onChange={(e) => setF({ ...f, timeZone: e.target.value })} aria-label="Часовой пояс">
        {(ZONES.some(([z]) => z === f.timeZone) ? ZONES : [[f.timeZone, f.timeZone] as [string, string], ...ZONES]).map(([z, n]) => <option key={z} value={z}>{n}</option>)}
      </select>
      <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void save()}>Сохранить</button>
      <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => setEdit(false)}>Отмена</button>
      {err && <span className="cal-phrase-err">{err}</span>}
    </div>
  );
}

/** Яндекс по CalDAV: логин и пароль приложения. */
function YandexDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const r = await calApi.connectYandex(login.trim(), password.trim());
      toastSaved('Яндекс Календарь подключён', r.calendar ?? '');
      onDone();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подключить'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Яндекс Календарь"
      description="Встречи QEVO появятся в Яндексе, события Яндекса — в QEVO. При отключении всё, что положил QEVO, удалится.">
      <ol className="cal-steps">
        <li>Откройте <a href="https://id.yandex.ru/security/app-passwords" target="_blank" rel="noreferrer">id.yandex.ru → Безопасность → Пароли приложений</a>.</li>
        <li>Создайте пароль для «Календарь CalDAV» и скопируйте его.</li>
        <li>Вставьте сюда логин Яндекса и этот пароль.</li>
      </ol>
      <input className="ui-input" placeholder="логин или почта Яндекса" value={login} onChange={(e) => setLogin(e.target.value)} aria-label="Логин Яндекса" />
      <input className="ui-input" type="password" placeholder="пароль приложения" value={password} onChange={(e) => setPassword(e.target.value)} aria-label="Пароль приложения" />
      {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
      <div className="cal-dialog-actions">
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !login || !password} onClick={() => void go()}>{busy ? 'Подключаю…' : 'Подключить'}</button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Отмена</button>
      </div>
    </Dialog>
  );
}

/** Outlook: наш календарь — подпиской в Outlook, их календарь — опубликованной ссылкой ICS. */
function OutlookDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [feed, setFeed] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  useEffect(() => { api.calendarExportLink().then((l) => setFeed(l.url)).catch(() => setFeed(null)); }, []);
  const add = async () => {
    setBusy(true); setErr('');
    try { await api.calendarAddImport(url.trim(), 'Outlook'); toastSaved('Outlook подключён', 'события Outlook видны в QEVO'); onDone(); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось подключить'); }
    finally { setBusy(false); }
  };
  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Outlook"
      description="Две ссылки: встречи QEVO — в Outlook, события Outlook — в QEVO. Отключение — удалить ссылку, служебных событий не остаётся.">
      <div className="cal-tt-label">1. Встречи QEVO → Outlook</div>
      {feed ? (
        <a className="ui-btn ui-btn-outline ui-btn-sm" target="_blank" rel="noreferrer"
          href={`https://outlook.live.com/calendar/0/addfromweb?url=${encodeURIComponent(feed)}&name=${encodeURIComponent('QEVO')}`}>
          <Icon name="link" size={14} /> Добавить календарь QEVO в Outlook
        </a>
      ) : <div className="dim cal-small">Готовлю ссылку…</div>}
      <div className="cal-tt-label">2. События Outlook → QEVO</div>
      <div className="dim cal-small">Outlook → Параметры → Календарь → Общие календари → Опубликовать календарь → скопируйте ссылку ICS.</div>
      <input className="ui-input" placeholder="https://outlook.office365.com/owa/calendar/…/calendar.ics" value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Ссылка ICS из Outlook" />
      {err && <div className="tv2-callout tv2-callout-danger" role="alert">{err}</div>}
      <div className="cal-dialog-actions">
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" disabled={busy || !/^https?:\/\//.test(url.trim())} onClick={() => void add()}>{busy ? 'Подключаю…' : 'Подключить'}</button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onClose}>Готово</button>
      </div>
    </Dialog>
  );
}

export type Provider = 'google' | 'yandex' | 'outlook';

/** Кнопки подключения и их окна — общие для первого входа и строки в шапке недели. */
export function useConnect(onConnected: () => void) {
  const [open, setOpen] = useState<Provider | null>(null);
  const start = (p: Provider) => {
    if (p === 'google') { void connectGoogle('calendar', '/calendar?connected=google'); return; }
    setOpen(p);
  };
  const done = () => { setOpen(null); onConnected(); };
  const dialogs = open === 'yandex' ? <YandexDialog onClose={() => setOpen(null)} onDone={done} />
    : open === 'outlook' ? <OutlookDialog onClose={() => setOpen(null)} onDone={done} /> : null;
  return { start, dialogs };
}

/**
 * Первый вход (#4892, п. 1): «Подключите календарь — Qevo покажет, куда уходит ваше
 * время». Google, Яндекс, Outlook, «Пропустить»; рабочие часы и обед — одной строкой.
 * После подключения — карточка недели: часы встреч, накладки, встречи подряд, окна
 * для фокуса; «Исправить за 1 минуту» ведёт к подсказкам ассистента.
 */
export function FirstRun({ prefs, week, onPrefs, onSkip, onConnected, onFix }: {
  prefs: CalPrefs; week: WeekAssistant | null;
  onPrefs: (p: CalPrefs) => void; onSkip: () => void; onConnected: () => void; onFix: () => void;
}) {
  const { start, dialogs } = useConnect(onConnected);
  const showInsight = prefs.connected.any && week;
  return (
    <section className="cal-first">
      <div className="cal-first-main">
        <div className="cal-first-kicker">Календарь · первый вход</div>
        <h2 className="cal-first-title">Подключите календарь — Qevo покажет, куда уходит ваше время</h2>
        <div className="cal-first-btns">
          <button type="button" className={`ui-btn ui-btn-sm ${prefs.connected.google ? 'ui-btn-outline' : 'ui-btn-primary'}`} onClick={() => start('google')}>
            {prefs.connected.google ? '✓ ' : ''}Google Календарь
          </button>
          <button type="button" className={`ui-btn ui-btn-sm ${prefs.connected.yandex ? 'ui-btn-outline' : 'ui-btn-primary'}`} onClick={() => start('yandex')}>
            {prefs.connected.yandex ? '✓ ' : ''}Яндекс Календарь
          </button>
          <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => start('outlook')}>Outlook</button>
          <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={onSkip}>{prefs.connected.any ? 'Готово' : 'Пропустить'}</button>
        </div>
        <HoursLine prefs={prefs} onSaved={onPrefs} />
      </div>
      {showInsight && <InsightCard week={week!} onFix={onFix} />}
      {dialogs}
    </section>
  );
}

export function InsightCard({ week, onFix }: { week: WeekAssistant; onFix: () => void }) {
  return (
    <div className="cal-insight">
      <div className="cal-first-kicker ok">Ваша неделя</div>
      <div className="cal-insight-head">Ваша неделя: {week.insight.meetingText}</div>
      <div className="cal-insight-row"><span>Накладки</span><b className={week.insight.overlaps ? 'bad' : ''}>{week.insight.overlaps}</b></div>
      <div className="cal-insight-row"><span>Встречи подряд без перерыва</span><b className={week.insight.backToBack ? 'warn' : ''}>{week.insight.backToBack} {week.insight.backToBack % 10 >= 2 && week.insight.backToBack % 10 <= 4 ? 'раза' : 'раз'}</b></div>
      <div className="cal-insight-row"><span>Окна для фокуса 2 ч+</span><b className="ok">{week.insight.focusWindows}</b></div>
      <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={onFix}>Исправить за 1 минуту</button>
    </div>
  );
}
