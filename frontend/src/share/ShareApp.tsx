import { useEffect, useState } from 'react';
import { Icon } from '../components/Icon';
import { apiUrl } from '../lib/origin';
import './share.css';

/**
 * Согласование результата клиентом (#4798 §19, #4799 BOARD09) — `/r/<ссылка>`, без входа.
 *
 * Клиент видит только то, что сотрудник выбрал: что было поручено, готовый результат
 * с пояснением и отмеченные файлы. Два действия — «Согласовать» и «Нужны изменения»;
 * ответ уходит в исходную задачу. Отозванная ссылка больше не открывается.
 */

interface View {
  title: string; summary: string; result: string; company: string | null; author: string | null;
  files: { id: string; name: string; mime: string }[];
  decision: 'approved' | 'changes' | null; decisionNote: string | null; decidedAt: string | null;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(apiUrl(`/api/share/${path}`), {
      method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Нет связи с сервером — проверьте интернет и попробуйте ещё раз');
  }
  const env = await res.json().catch(() => null) as { ok: boolean; data?: T; error?: { message?: string } } | null;
  if (!env?.ok) throw new Error(env?.error?.message ?? 'Что-то пошло не так');
  return env.data as T;
}

export default function ShareApp() {
  const token = decodeURIComponent(location.pathname.slice('/r/'.length)).replace(/\/+$/, '');
  const [view, setView] = useState<View | null>(null);
  const [err, setErr] = useState('');
  const [mode, setMode] = useState<'approve' | 'changes' | null>(null);
  const [note, setNote] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    document.title = 'Согласование результата';
    call<View>('GET', encodeURIComponent(token)).then(setView).catch((e) => setErr((e as Error).message));
  }, [token]);

  const openFile = async (id: string) => {
    try {
      const r = await call<{ url: string }>('POST', `${encodeURIComponent(token)}/files/${id}`);
      window.open(apiUrl(r.url), '_blank', 'noopener');
    } catch (e) { setErr((e as Error).message); }
  };

  const send = async () => {
    if (!mode) return;
    if (mode === 'changes' && !note.trim()) { setErr('Напишите, что изменить'); return; }
    setBusy(true); setErr('');
    try {
      await call('POST', `${encodeURIComponent(token)}/decision`, { decision: mode === 'approve' ? 'approved' : 'changes', note: note.trim(), name: name.trim() });
      setView((v) => (v ? { ...v, decision: mode === 'approve' ? 'approved' : 'changes', decisionNote: note.trim(), decidedAt: new Date().toISOString() } : v));
    } catch (e) { setErr((e as Error).message); } finally { setBusy(false); }
  };

  if (!view) {
    return (
      <main className="sh">
        <div className="sh-card">{err ? <p role="alert">{err}</p> : <p className="sh-dim">Загружаю…</p>}</div>
      </main>
    );
  }
  return (
    <main className="sh">
      <article className="sh-card">
        <div className="sh-dim">{view.company ?? 'QEVO'} · согласование результата</div>
        <h1>{view.title}</h1>
        <section>
          <h2>Что было поручено</h2>
          <p className="sh-text">{view.summary}</p>
        </section>
        <section>
          <h2>Готовый результат</h2>
          <p className="sh-text">{view.result}</p>
          {view.author && <p className="sh-dim">Пояснение подготовил(а): {view.author}</p>}
        </section>
        {view.files.length > 0 && (
          <section>
            <h2>Материалы</h2>
            <ul className="sh-files">
              {view.files.map((f) => (
                <li key={f.id}><button className="sh-link" onClick={() => void openFile(f.id)}><Icon name="paperclip" size={14} /> {f.name}</button></li>
              ))}
            </ul>
          </section>
        )}

        {view.decision ? (
          <div className="sh-done" role="status">
            <Icon name={view.decision === 'approved' ? 'check-circle' : 'reply'} size={18} />
            {view.decision === 'approved' ? 'Результат согласован. Спасибо!' : 'Замечания отправлены команде — они уже видят их в задаче.'}
            {view.decisionNote && <p className="sh-dim">{view.decisionNote}</p>}
          </div>
        ) : (
          <section className="sh-act">
            {!mode && (
              <div className="sh-btns">
                <button className="ui-btn ui-btn-primary" onClick={() => setMode('approve')}><Icon name="check" size={16} /> Согласовать</button>
                <button className="ui-btn ui-btn-outline" onClick={() => setMode('changes')}><Icon name="edit" size={16} /> Нужны изменения</button>
              </div>
            )}
            {mode && (
              <div className="sh-form">
                <label>Как вас зовут
                  <input className="ui-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Имя" />
                </label>
                <label>{mode === 'approve' ? 'Комментарий (необязательно)' : 'Что изменить'}
                  <textarea className="ui-input" rows={4} value={note} onChange={(e) => setNote(e.target.value)} autoFocus={mode === 'changes'} />
                </label>
                <div className="sh-btns">
                  <button className="ui-btn ui-btn-primary" disabled={busy} onClick={() => void send()}>{mode === 'approve' ? 'Согласовать' : 'Отправить замечания'}</button>
                  <button className="ui-btn ui-btn-ghost" disabled={busy} onClick={() => setMode(null)}>Назад</button>
                </div>
              </div>
            )}
          </section>
        )}
        {err && <p className="sh-err" role="alert">{err}</p>}
      </article>
    </main>
  );
}
