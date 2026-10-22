import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api';
import type { SupportConcierge } from '../../lib/api';
import { collectSupportContext } from '../../lib/support-context';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { Avatar } from '../Avatar';
import { Icon } from '../Icon';
import { VoiceStatus } from '../VoiceStatus';
import { openSupport } from '../support/SupportDock';

/** Кнопки сервисов — дословно из документа («Старт», пункт 4, шаг 1). */
const SOURCES = [
  'Из Trello / Jira / Asana / YouGile',
  'Из Notion / ClickUp / Monday',
  'Из таблицы Excel / Google Таблиц',
  'Из рабочих чатов Telegram / WhatsApp',
] as const;
const VOICE = 'Сказать голосом — соберите структуру проектов под меня';

/** Дежурные — один запрос на все места первого запуска: карточка выбора и окно заботы. */
let desk: Promise<SupportConcierge | null> | null = null;
function concierge(): Promise<SupportConcierge | null> {
  desk ??= api.supportConcierge().catch(() => null);
  return desk;
}

const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '·';

/** Живые лица дежурных инженеров: фото, а нет фото — инициалы. */
export function Faces({ max }: { max: number }) {
  const [d, setD] = useState<SupportConcierge | null>(null);
  useEffect(() => { let on = true; void concierge().then((v) => { if (on) setD(v); }); return () => { on = false; }; }, []);
  // сначала — кто на связи прямо сейчас
  const list = [...(d?.engineers ?? [])]
    .sort((a, b) => Number(b.status === 'available') - Number(a.status === 'available'))
    .slice(0, max);
  if (!list.length) {
    return (
      <span className="wl-faces" aria-hidden="true">
        {Array.from({ length: max }, (_, k) => <span key={k} className="wl-face wl-face-ph"><Icon name="user" size={16} /></span>)}
      </span>
    );
  }
  return (
    <span className="wl-faces" aria-label={`На связи: ${list.map((e) => e.name).join(', ')}`}>
      {list.map((e) => <Avatar key={e.userId} path={e.avatarUrl} fallback={initials(e.name)} className="wl-face" />)}
    </span>
  );
}

/**
 * Кнопка 2 (#4620, «Старт» п.4): окно Отдела заботы с лицами дежурных и кнопками
 * сервисов. Нажали — обращение уходит в свой разговор службы заботы с выбранным
 * источником (и файлом выгрузки или ссылкой, если приложили), и разговор открывается:
 * инженер отвечает там же. Ход переноса показывает сама служба заботы.
 */
export function CareStart({ onClose, onSent }: { onClose: () => void; onSent: () => void }) {
  const [d, setD] = useState<SupportConcierge | null>(null);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const pick = useRef<HTMLInputElement | null>(null);
  const first = useRef<HTMLButtonElement | null>(null);

  useEffect(() => { void concierge().then(setD); }, []);
  useEffect(() => { first.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) { e.preventDefault(); onClose(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const send = async (source: string, said?: string) => {
    if (busy) return;
    setBusy(true); setErr('');
    const text = [`Перенос задач: ${source}`, said, note.trim()].filter(Boolean).join('\n');
    try {
      if (file) await api.supportAttach(file, text);
      else await api.supportSend(text, collectSupportContext());
      openSupport();
      onSent();
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось отправить — попробуйте ещё раз');
      setBusy(false);
    }
  };
  const voice = useVoiceInput((said) => { void send(VOICE, said); });

  const live = d?.engineers.filter((e) => e.status === 'available').length ?? 0;
  return (
    <div className="wl-layer" role="dialog" aria-modal="true" aria-labelledby="wl-care-title">
      <div className="wl-care">
        <button className="wl-x" onClick={onClose} disabled={busy} title="Закрыть (Esc)" aria-label="Закрыть"><Icon name="close" size={18} /></button>
        <div className="wl-care-head">
          <Faces max={5} />
          <span className="wl-care-live"><span className="wl-pulse" aria-hidden="true" /> {d?.estimate.text || (live ? `${live} на связи` : 'Отдел заботы Qevo')}</span>
        </div>
        <h2 id="wl-care-title">Откуда переносим задачи?</h2>
        <div className="wl-sources">
          {SOURCES.map((s, k) => (
            <button key={s} ref={k === 0 ? first : undefined} className="wl-source" disabled={busy} onClick={() => void send(s)}>
              <Icon name={k === 2 ? 'file' : k === 3 ? 'chat' : 'board'} size={18} /> {s}
            </button>
          ))}
          <button
            className={`wl-source wl-source-voice${voice.recording ? ' is-rec' : ''}`}
            disabled={busy || voice.transcribing}
            onClick={voice.toggle}
            aria-pressed={voice.recording}
          >
            <Icon name={voice.recording ? 'stop' : 'mic'} size={18} /> {VOICE}
          </button>
        </div>
        <VoiceStatus recording={voice.recording} transcribing={voice.transcribing} error={voice.error} hint="нажмите ещё раз, чтобы отправить" />
        <div className="wl-care-extra">
          <input
            className="input"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Ссылка на доску или список задач — по желанию"
            aria-label="Ссылка или список задач"
          />
          <button className="ui-btn ui-btn-outline ui-btn-md" onClick={() => pick.current?.click()} disabled={busy} title="Приложить файл выгрузки">
            <Icon name="paperclip" size={16} /> {file ? file.name : 'Файл'}
          </button>
          <input ref={pick} type="file" hidden onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {err && <div className="error-text" role="alert">{err}</div>}
      </div>
    </div>
  );
}
