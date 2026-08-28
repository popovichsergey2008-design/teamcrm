import { useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { DatePicker } from './DatePicker';
import { VoiceStatus } from './VoiceStatus';

/**
 * NL-команда / Zero-UI: сказал или написал обычным языком → готовый черновик → подтвердил.
 *
 * Голос идёт насквозь: остановил запись — и черновик уже собран. Раньше между речью
 * и результатом стояла ещё одна кнопка «Распознать», и человек, продиктовав задачу,
 * смотрел на свой же текст в поле, не понимая, чего от него хотят.
 */
export function NlCommandModal({ onClose, initialText, autoRecord, currentProjectId, onCreated }: {
  onClose: () => void;
  /** Текст, набранный в командной строке: переспрашивать уже сформулированное незачем. */
  initialText?: string;
  /** Пришли по кнопке микрофона — сразу слушаем, не заставляя нажимать ещё раз. */
  autoRecord?: boolean;
  /** Доска, открытая у человека: из неё берётся проект, если он не назван вслух. */
  currentProjectId?: string | null;
  /** Задача создана — показать её вместо перезагрузки всего приложения. */
  onCreated?: (projectId: string, taskId: string) => void;
}) {
  const [text, setText] = useState(initialText ?? '');
  const [draft, setDraft] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  /** Фраза, из которой собран черновик: «услышал не то» иначе не объяснить. */
  const [heard, setHeard] = useState('');

  const parse = async (raw?: string) => {
    const command = (raw ?? text).trim();
    if (command.length < 3) return setMsg('Слишком короткая команда');
    setBusy(true); setMsg(''); setDraft(null);
    try {
      setDraft(await api.nlParse(command, currentProjectId));
      setHeard(command);
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка распознавания'); }
    finally { setBusy(false); }
  };

  // Расшифровка речи сразу уходит в разбор: голос — это одно действие, а не три.
  const voice = useVoiceInput((spoken) => {
    const next = text.trim() ? `${text.trim()} ${spoken}` : spoken;
    setText(next);
    void parse(next);
  });
  const { recording, transcribing } = voice;

  // Автозапуск ровно один раз: в режиме разработки эффекты вызываются дважды,
  // и без флага открывались бы два микрофонных потока подряд.
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoRecord || autoStarted.current) return;
    autoStarted.current = true;
    voice.start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRecord]);

  const setTask = (patch: any) => setDraft((d: any) => (d ? { ...d, task: { ...d.task, ...patch } } : d));
  const setDeal = (patch: any) => setDraft((d: any) => (d ? { ...d, deal: { ...d.deal, ...patch } } : d));

  const apply = async () => {
    if (!draft) return;
    setBusy(true); setMsg('');
    try {
      const body = draft.intent === 'create_task'
        ? { intent: 'create_task', task: draft.task }
        : { intent: 'create_deal', deal: draft.deal };
      const res: any = await api.nlApply(body);
      // Раньше здесь перезагружалась вся страница: человек терял открытый раздел
      // и не видел, куда легла задача. Теперь открываем саму задачу.
      if (res?.task && onCreated) onCreated(String(res.task.project_id ?? res.task.projectId), String(res.task.id));
      else window.location.reload();
      onClose();
    } catch (e) { setMsg(e instanceof ApiError ? e.message : 'Ошибка создания'); setBusy(false); }
  };

  const ctx = draft?.context ?? { projects: [], users: [], clients: [] };
  const conf = draft?.confidence
    ? <span className="dim" style={{ fontSize: 11, marginLeft: 6 }}>увер. {Math.round(draft.confidence * 100)}%</span>
    : null;
  const busyLabel = transcribing ? 'Распознаю речь…' : busy ? 'Разбираю команду…' : '';

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="zap" size={18} /> Быстрая команда</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>
        <div className="dim" style={{ fontSize: 12 }}>
          Скажите или напишите обычным языком — черновик соберётся сам, вам останется подтвердить.
          Например: «Иванову обновить баннер на главной к пятнице, срочно».
        </div>
        {msg && <div className="error-text">{msg}</div>}

        <textarea
          className="input"
          rows={3}
          placeholder="Ваша команда…"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void parse(); }}
          style={{ marginTop: 6 }}
        />
        <VoiceStatus
          recording={recording}
          transcribing={transcribing}
          error={voice.error}
          hint="нажмите «Остановить», когда закончите"
          className="nl-voice"
        />

        <div className="nl-actions">
          <button
            className={`btn btn-sm ${recording ? 'btn-primary' : 'btn-ghost'}`}
            onClick={voice.toggle}
            disabled={busy || transcribing}
          >
            {recording
              ? <><Icon name="stop" size={14} /> Остановить</>
              : <><Icon name="mic" size={14} /> {draft ? 'Сказать заново' : 'Голосом'}</>}
          </button>
          <button className="btn btn-primary btn-sm nl-parse" onClick={() => void parse()} disabled={busy || recording || transcribing}>
            <Icon name="sparkles" size={14} /> {busyLabel || 'Разобрать'}
          </button>
        </div>

        {heard && draft && (
          <div className="dim nl-heard" title="Что услышала система из вашей фразы">
            <Icon name="mic" size={12} /> {heard}
          </div>
        )}

        {draft && draft.intent === 'none' && (
          <div className="muted" style={{ marginTop: 12 }}>Не понял команду{draft.note ? `: ${draft.note}` : ''}. Уточните формулировку.</div>
        )}

        {draft && draft.intent === 'create_task' && draft.task && (
          <div style={{ marginTop: 12 }}>
            <div className="drawer-section-title">Задача{conf}</div>
            {draft.warnings?.map((w: string, i: number) => <div key={i} className="error-text" style={{ fontSize: 12 }}><Icon name="alert" size={12} /> {w}</div>)}
            <input className="input" placeholder="Название" value={draft.task.title} onChange={(e) => setTask({ title: e.target.value })} />
            <textarea className="input" rows={2} placeholder="Описание (необязательно)" value={draft.task.description ?? ''} onChange={(e) => setTask({ description: e.target.value })} style={{ marginTop: 6 }} />
            <select className="input" style={{ marginTop: 6 }} value={draft.task.projectId ?? ''} onChange={(e) => setTask({ projectId: e.target.value || null, projectHint: '' })}>
              <option value="">— проект (обязательно) —</option>
              {ctx.projects.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            {/* Откуда взялся проект: подставленный молча, он однажды окажется не тем. */}
            {draft.task.projectHint && <div className="dim nl-hint">{draft.task.projectHint}</div>}
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
            <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 8 }} onClick={apply} disabled={busy || !draft.task.projectId}>
              {draft.task.projectId ? 'Создать задачу' : 'Выберите проект'}
            </button>
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
