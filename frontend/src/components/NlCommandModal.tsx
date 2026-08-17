import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { DatePicker } from './DatePicker';

/** NL-команда / Zero-UI: пишешь ИЛИ говоришь обычным языком → ИИ предлагает создать задачу/сделку → подтверждаешь. */
export function NlCommandModal({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState('');
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const recRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);

  // запись голоса → Whisper → текст в то же поле команды (дальше обычное распознавание)
  const startRec = async () => {
    setMsg('');
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
      return setMsg('Браузер не поддерживает запись с микрофона');
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream);
      chunksRef.current = [];
      mr.ondataavailable = (e) => { if (e.data.size) chunksRef.current.push(e.data); };
      mr.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setRecording(false);
        const blob = new Blob(chunksRef.current, { type: mr.mimeType || 'audio/webm' });
        if (!blob.size) return;
        setTranscribing(true);
        try {
          const { text: t } = await api.nlTranscribe(blob);
          if (!t) setMsg('Речь не распознана. Для голоса нужен ключ OpenAI (Whisper) в «Интеграции → ИИ», либо введите текстом.');
          else setText((prev) => (prev.trim() ? prev.trim() + ' ' : '') + t);
        } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка распознавания речи'); }
        finally { setTranscribing(false); }
      };
      mr.start();
      recRef.current = mr;
      setRecording(true);
    } catch { setMsg('Нет доступа к микрофону'); }
  };
  const stopRec = () => recRef.current?.stop();
  const toggleRec = () => (recording ? stopRec() : startRec());

  // остановить запись и отпустить микрофон, если модалку закрыли на середине
  useEffect(() => () => { if (recRef.current && recRef.current.state !== 'inactive') recRef.current.stop(); }, []);

  const parse = async () => {
    if (text.trim().length < 3) return setMsg('Слишком короткая команда');
    setBusy(true); setMsg(''); setDraft(null);
    try { setDraft(await api.nlParse(text.trim())); }
    catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка распознавания'); }
    finally { setBusy(false); }
  };

  const setTask = (patch: any) => setDraft((d: any) => (d ? { ...d, task: { ...d.task, ...patch } } : d));
  const setDeal = (patch: any) => setDraft((d: any) => (d ? { ...d, deal: { ...d.deal, ...patch } } : d));

  const apply = async () => {
    if (!draft) return;
    setBusy(true); setMsg('');
    try {
      const body = draft.intent === 'create_task'
        ? { intent: 'create_task', task: draft.task }
        : { intent: 'create_deal', deal: draft.deal };
      await api.nlApply(body);
      window.location.reload(); // показать созданную сущность
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка создания'); setBusy(false); }
  };

  const ctx = draft?.context ?? { projects: [], users: [], clients: [] };
  const conf = draft?.confidence ? <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>увер. {Math.round(draft.confidence * 100)}%</span> : null;

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3><Icon name="zap" size={18} /> Быстрая команда</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="dim" style={{ fontSize: 12 }}>
          Напишите или продиктуйте обычным языком — ИИ поймёт и предложит создать задачу или сделку (с подтверждением).
          Например: «Иванову задача обновить баннер на главной к пятнице, срочно».
        </div>
        {msg && <div className="error-text">{msg}</div>}
        <textarea className="input" rows={3} placeholder="Ваша команда…" value={text} onChange={(e) => setText(e.target.value)} style={{ marginTop: 6 }} />
        <button
          className={`btn btn-sm ${recording ? 'btn-primary' : 'btn-ghost'}`}
          style={{ width: '100%', marginTop: 6 }}
          onClick={toggleRec}
          disabled={busy || transcribing}
        >
          {recording ? <><Icon name="stop" size={14} /> Остановить и распознать</> : transcribing ? 'Распознаю речь…' : <><Icon name="mic" size={14} /> Записать голосом</>}
        </button>
        <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={parse} disabled={busy || recording || transcribing}>
          {busy && !draft ? 'Распознаю…' : <><Icon name="sparkles" size={14} /> Распознать</>}
        </button>

        {draft && draft.intent === 'none' && (
          <div className="muted" style={{ marginTop: 12 }}>Не понял команду{draft.note ? `: ${draft.note}` : ''}. Уточните формулировку.</div>
        )}

        {draft && draft.intent === 'create_task' && draft.task && (
          <div style={{ marginTop: 12 }}>
            <div className="drawer-section-title">Задача{conf}</div>
            {draft.warnings?.map((w: string, i: number) => <div key={i} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>)}
            <input className="input" placeholder="Название" value={draft.task.title} onChange={(e) => setTask({ title: e.target.value })} />
            <textarea className="input" rows={2} placeholder="Описание (необязательно)" value={draft.task.description ?? ''} onChange={(e) => setTask({ description: e.target.value })} style={{ marginTop: 6 }} />
            <select className="input" style={{ marginTop: 6 }} value={draft.task.projectId ?? ''} onChange={(e) => setTask({ projectId: e.target.value || null })}>
              <option value="">— проект (обязательно) —</option>
              {ctx.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <select className="input" style={{ marginTop: 6 }} value={draft.task.assigneeId ?? ''} onChange={(e) => setTask({ assigneeId: e.target.value || null })}>
              <option value="">— исполнитель —</option>
              {ctx.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </select>
            <div className="team-rate" style={{ marginTop: 6 }}>
              <select className="input" value={draft.task.priority} onChange={(e) => setTask({ priority: e.target.value })}>
                <option value="low">Низкий</option><option value="normal">Обычный</option><option value="high">Высокий</option><option value="urgent">Срочный</option>
              </select>
              <DatePicker value={draft.task.deadline ?? ''} onChange={(v) => setTask({ deadline: v || null })} placeholder="срок не задан" />
            </div>
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={apply} disabled={busy || !draft.task.projectId}>Создать задачу</button>
          </div>
        )}

        {draft && draft.intent === 'create_deal' && draft.deal && (
          <div style={{ marginTop: 12 }}>
            <div className="drawer-section-title">Сделка{conf}</div>
            {draft.warnings?.map((w: string, i: number) => <div key={i} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>)}
            <input className="input" placeholder="Название сделки" value={draft.deal.title} onChange={(e) => setDeal({ title: e.target.value })} />
            <div className="team-rate" style={{ marginTop: 6 }}>
              <input className="input" type="number" placeholder="Сумма" value={draft.deal.amount ?? ''} onChange={(e) => setDeal({ amount: e.target.value === '' ? null : Number(e.target.value) })} />
              <input className="input" type="number" placeholder="Маржа %" value={draft.deal.plannedMargin ?? ''} onChange={(e) => setDeal({ plannedMargin: e.target.value === '' ? null : Number(e.target.value) })} />
            </div>
            <select className="input" style={{ marginTop: 6 }} value={draft.deal.clientId ?? ''} onChange={(e) => setDeal({ clientId: e.target.value || null })}>
              <option value="">— клиент —</option>
              {ctx.clients.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={apply} disabled={busy}>Создать сделку</button>
          </div>
        )}
      </aside>
    </div>
  );
}
