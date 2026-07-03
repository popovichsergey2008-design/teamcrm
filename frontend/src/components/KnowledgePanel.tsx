import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/** База знаний (Этап 5, K1): семантический поиск + регламенты + реиндекс. */
export function KnowledgePanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<'brain' | 'search' | 'regs'>('brain');
  const [msg, setMsg] = useState('');
  const [stats, setStats] = useState<{ chunks: string; sources: string } | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };
  const loadStats = () => api.knowledgeStats().then(setStats).catch(() => undefined);
  useEffect(() => { loadStats(); }, []);

  // поиск
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const doSearch = async () => {
    if (q.trim().length < 2) return;
    setSearching(true);
    try { setHits(await api.knowledgeSearch(q.trim())); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка поиска'); }
    finally { setSearching(false); }
  };

  // регламенты
  const [regs, setRegs] = useState<any[]>([]);
  const [form, setForm] = useState({ title: '', body: '' });
  const loadRegs = () => api.listRegulations().then(setRegs).catch(() => undefined);
  useEffect(() => { if (tab === 'regs') loadRegs(); }, [tab]);
  const addReg = async () => {
    if (!form.title.trim() || !form.body.trim()) return flash('Заполните заголовок и текст');
    try { await api.createRegulation({ title: form.title.trim(), body: form.body }); setForm({ title: '', body: '' }); flash('Регламент добавлен, индексируется'); loadRegs(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const delReg = async (id: string) => { if (window.confirm('Удалить регламент?')) { await api.deleteRegulation(id); loadRegs(); } };

  const reindex = async () => {
    try { const r = await api.knowledgeReindex(); flash(`В очередь на индексацию: ${r.queued}`); setTimeout(loadStats, 2000); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  // AI Brain
  const [convId, setConvId] = useState<string | null>(null);
  const [chat, setChat] = useState<{ role: string; content: string; citations?: any[] }[]>([]);
  const [ask, setAsk] = useState('');
  const [thinking, setThinking] = useState(false);
  const sendAsk = async () => {
    const q = ask.trim();
    if (q.length < 2) return;
    setAsk('');
    setChat((c) => [...c, { role: 'user', content: q }]);
    setThinking(true);
    try {
      let id = convId;
      if (!id) { id = (await api.brainStart()).id; setConvId(id); }
      const r = await api.brainAsk(id, q);
      setChat((c) => [...c, { role: 'assistant', content: r.answer, citations: r.citations }]);
    } catch (e) {
      setChat((c) => [...c, { role: 'assistant', content: e instanceof ApiError ? e.message : 'Ошибка' }]);
    } finally { setThinking(false); }
  };
  const citeLabel = (c: any) => (c.sourceType === 'task' ? 'задача' : c.sourceType === 'comment' ? 'комментарий' : 'регламент') + (c.title ? `: ${c.title}` : '');

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3>База знаний</h3><button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button></div>
        <div className="dim" style={{ fontSize: 12 }}>
          В индексе: {stats?.chunks ?? '—'} фрагментов из {stats?.sources ?? '—'} источников (закрытые задачи, комментарии, регламенты).
          {canManage && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reindex}>Переиндексировать всё</button>}
        </div>
        <div className="tabs">
          <button className={`tab ${tab === 'brain' ? 'active' : ''}`} onClick={() => setTab('brain')}>Спросить ИИ</button>
          <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>Поиск</button>
          <button className={`tab ${tab === 'regs' ? 'active' : ''}`} onClick={() => setTab('regs')}>Регламенты</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'brain' && (
          <>
            <div className="brain-chat">
              {chat.length === 0 && <div className="muted">Спросите «корпоративный разум»: как мы решали ту или иную задачу? Ответ — по архиву задач, комментариев и регламентов, со ссылками на источники.</div>}
              {chat.map((m, i) => (
                <div key={i} className={`brain-msg brain-${m.role}`}>
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}</div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="brain-cites">
                      {m.citations.map((c, j) => <span key={j} className="badge" title={citeLabel(c)}>[{j + 1}] {citeLabel(c).slice(0, 40)}</span>)}
                    </div>
                  )}
                </div>
              ))}
              {thinking && <div className="brain-msg brain-assistant dim">Думаю…</div>}
            </div>
            <div className="team-rate">
              <input className="input" placeholder="Ваш вопрос…" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !thinking && sendAsk()} />
              <button className="btn btn-primary btn-sm" onClick={sendAsk} disabled={thinking}>Спросить</button>
            </div>
          </>
        )}

        {tab === 'search' && (
          <>
            <div className="team-rate">
              <input className="input" placeholder="Спросите: как мы решали…?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
              <button className="btn btn-primary btn-sm" onClick={doSearch} disabled={searching}>{searching ? '…' : 'Найти'}</button>
            </div>
            {hits && hits.length === 0 && <div className="muted" style={{ marginTop: 10 }}>Ничего не найдено</div>}
            {hits?.map((h, i) => (
              <div key={i} className="team-row">
                <div className="team-head">
                  <span><span className="badge">{h.sourceType === 'task' ? 'задача' : h.sourceType === 'comment' ? 'комментарий' : 'регламент'}</span> {h.title || '—'}</span>
                  <span className="dim" style={{ fontSize: 12 }}>{Math.round((h.score ?? 0) * 100)}%</span>
                </div>
                <div className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{h.snippet}</div>
              </div>
            ))}
          </>
        )}

        {tab === 'regs' && (
          <>
            {canManage && (
              <div className="add-user">
                <input className="input add-user-input" placeholder="Заголовок регламента" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
                <textarea className="input" rows={5} placeholder="Текст регламента (будет проиндексирован в базу знаний)" value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} />
                <button className="btn btn-primary btn-sm" style={{ width: '100%' }} onClick={addReg}>Добавить регламент</button>
              </div>
            )}
            {regs.map((r) => (
              <div key={r.id} className="team-row team-head">
                <span>{r.title} <span className="dim" style={{ fontSize: 12 }}>{r.excerpt}</span></span>
                {canManage && <button className="btn btn-ghost btn-sm" onClick={() => delReg(r.id)}>Удалить</button>}
              </div>
            ))}
            {regs.length === 0 && <div className="muted">Регламентов пока нет</div>}
          </>
        )}
      </aside>
    </div>
  );
}
