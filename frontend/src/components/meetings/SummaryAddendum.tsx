import { useState } from 'react';
import { Icon } from '../Icon';
import { api, ApiError } from '../../lib/api';
import { useVoiceInput } from '../../hooks/useVoiceInput';
import { useHoldToTalk } from '../../hooks/useHoldToTalk';
import { toastSaved } from '../../lib/notifications';

/**
 * Дополнить сводку встречи голосом (19.11.2026): ИИ пропустил важное — участник надиктовывает,
 * проверяет распознанный текст и сохраняет. Сервер встраивает дополнение в сводку, ничего из
 * неё не удаляя. Можно и напечатать — поле то же.
 */
export function SummaryAddendum({ meetingId, onSaved }: { meetingId: string; onSaved: () => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const voice = useVoiceInput((t) => setText((v) => (v.trim() ? `${v.trim()} ${t}` : t)));
  // #5030: микрофон как в Telegram — удерживать и говорить, отпустить — готово, вверх — отмена
  const hold = useHoldToTalk({ start: voice.start, stop: voice.stop, cancel: voice.cancel, recording: voice.recording });

  const save = async () => {
    if (text.trim().length < 3) { setErr('Надиктуйте или напишите, что добавить'); return; }
    setBusy(true); setErr('');
    try {
      await api.addToMeetingSummary(meetingId, text.trim());
      toastSaved('Сводка дополнена');
      setText(''); setOpen(false); onSaved();
    } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось сохранить'); }
    finally { setBusy(false); }
  };

  if (!open) {
    return (
      <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" style={{ marginTop: 8 }}
        onClick={() => { setOpen(true); void voice.start(); }}
        title="ИИ что-то пропустил? Надиктуйте — дополнение встанет в сводку">
        <Icon name="mic" size={13} /> Дополнить сводку голосом
      </button>
    );
  }
  return (
    <div className="meeting-addendum" style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div className="dim" style={{ fontSize: 12 }}>
        {voice.recording ? 'Говорите — что пропущено в сводке. Нажмите «Стоп», когда закончите.'
          : voice.transcribing ? 'Распознаю…' : 'Проверьте текст и сохраните — он встанет в сводку.'}
      </div>
      <textarea className="ui-input" rows={3} value={text} onChange={(e) => setText(e.target.value)}
        placeholder="Например: ещё договорились подклеить дропы к домену с дефисом до завтра, отвечает Никита" />
      {(err || voice.error) && <div className="error-text" role="alert" style={{ fontSize: 12 }}>{err || voice.error}</div>}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" className={`ui-btn ui-btn-sm ${voice.recording ? 'ui-btn-primary' : 'ui-btn-outline'}`}
          {...hold.bind} disabled={voice.transcribing || busy}>
          <Icon name={voice.recording ? 'stop' : 'mic'} size={13} /> {voice.recording ? 'Стоп' : 'Надиктовать ещё'}
        </button>
        <button type="button" className="ui-btn ui-btn-primary ui-btn-sm" onClick={() => void save()}
          disabled={busy || voice.recording || voice.transcribing || text.trim().length < 3}>
          {busy ? 'Сохраняю…' : 'Сохранить в сводку'}
        </button>
        <button type="button" className="ui-btn ui-btn-ghost ui-btn-sm" onClick={() => { voice.stop(); setOpen(false); setText(''); setErr(''); }} disabled={busy}>
          Отмена
        </button>
      </div>
    </div>
  );
}
