import { useEffect, useState } from 'react';
import { EmptyState } from './EmptyState';
import { Icon } from './Icon';
import { api, ApiError } from '../lib/api';
import { useEscape } from '../hooks/useEscape';

/** База знаний (Этап 5, K1): семантический поиск + регламенты + реиндекс. */
export function KnowledgePanel({ canManage, onClose }: { canManage: boolean; onClose: () => void }) {
  useEscape(onClose); // закрытие с клавиатуры, а не только крестиком
  const [tab, setTab] = useState<'brain' | 'search' | 'regs' | 'content'>('brain');
  const [msg, setMsg] = useState('');
  const [stats, setStats] = useState<{ chunks: string; sources: string } | null>(null);
  const [usage, setUsage] = useState<{ totalCalls: number; cacheHits: number; cacheHitRatio: number } | null>(null);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };
  const loadStats = () => {
    api.knowledgeStats().then(setStats).catch(() => undefined);
    if (canManage) api.aiUsage().then(setUsage).catch(() => undefined);
  };
  const [projects, setProjects] = useState<any[]>([]);
  const [scope, setScope] = useState(''); // '' = вся организация, иначе projectId
  const [gd, setGd] = useState<{ scanning: boolean; total: number; byStatus: Record<string, number> } | null>(null);
  const loadGdocs = () => api.gdocsStatus().then(setGd).catch(() => undefined);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { loadStats(); api.listProjects().then(setProjects).catch(() => undefined); if (canManage) loadGdocs(); }, []);

  const scanGdocs = async () => {
    try {
      const r = await api.gdocsScan();
      flash(r.started ? 'Сканирование Google-доков запущено…' : 'Сканирование уже идёт');
      loadGdocs();
      let ticks = 0;
      const iv = setInterval(async () => {
        const s = await api.gdocsStatus().catch(() => null);
        if (s) { setGd(s); if (!s.scanning) { clearInterval(iv); loadStats(); } }
        if (++ticks > 240) clearInterval(iv); // предохранитель ~10 мин
      }, 2500);
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const ScopeSelect = () => (
    <select className="input" style={{ maxWidth: 220 }} value={scope} onChange={(e) => setScope(e.target.value)} title="Разрез базы знаний">
      <option value="">Вся организация</option>
      {projects.map((p) => <option key={p.id} value={p.id}>Проект: {p.name}</option>)}
    </select>
  );

  // поиск
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<any[] | null>(null);
  const [searching, setSearching] = useState(false);
  const doSearch = async () => {
    if (q.trim().length < 2) return;
    setSearching(true);
    try { setHits(await api.knowledgeSearch(q.trim(), 8, scope || undefined)); }
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

  // просмотр содержимого базы
  const srcTypeLabel = (t: string) => t === 'task' ? 'задача' : t === 'comment' ? 'комментарий' : t === 'gdoc' ? 'Google-док' : 'регламент';
  const [sources, setSources] = useState<any[]>([]);
  const [srcType, setSrcType] = useState('');
  const [srcQ, setSrcQ] = useState('');
  const [srcOffset, setSrcOffset] = useState(0);
  const [srcHasMore, setSrcHasMore] = useState(false);
  const [openSrc, setOpenSrc] = useState<{ key: string; data: any | null } | null>(null);
  const loadSources = async (reset: boolean) => {
    const offset = reset ? 0 : srcOffset;
    try {
      const res = await api.knowledgeSources({ projectId: scope || undefined, type: srcType || undefined, q: srcQ.trim() || undefined, offset });
      setSources((prev) => (reset ? res.items : [...prev, ...res.items]));
      setSrcOffset(offset + res.items.length);
      setSrcHasMore(res.hasMore);
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (tab === 'content') { setOpenSrc(null); loadSources(true); } }, [tab, scope, srcType]);
  const viewSource = async (type: string, id: string) => {
    const key = `${type}:${id}`;
    if (openSrc?.key === key) return setOpenSrc(null);
    setOpenSrc({ key, data: null });
    try { setOpenSrc({ key, data: await api.knowledgeSource(type, id) }); }
    catch { setOpenSrc({ key, data: { text: 'Не удалось загрузить' } }); }
  };

  // AI Brain
  const [convId, setConvId] = useState<string | null>(null);
  const [chat, setChat] = useState<{ role: string; content: string; citations?: any[]; cached?: boolean; promptVersionId?: string | null; rated?: 1 | -1; _id?: string }[]>([]);
  const [ask, setAsk] = useState('');
  const [thinking, setThinking] = useState(false);
  const sendAsk = async () => {
    const q = ask.trim();
    if (q.length < 2) return;
    setAsk('');
    // стабильный id сообщения ассистента, в которое «печатается» ответ (безопасно к StrictMode)
    const aid = `a${Date.now()}_${Math.random().toString(36).slice(2)}`;
    setChat((c) => [...c, { role: 'user', content: q }, { role: 'assistant', content: '', _id: aid }]);
    setThinking(true);
    const patch = (p: Partial<{ content: string; citations: any[]; cached: boolean; promptVersionId: string | null }>) =>
      setChat((c) => c.map((m) => (m._id === aid ? { ...m, ...p } : m)));
    try {
      let id = convId;
      if (!id) { id = (await api.brainStart()).id; setConvId(id); }
      let acc = '';
      const streamed = await api.brainAskStream(id, q, scope || undefined, {
        onCitations: (cites) => patch({ citations: cites }),
        onDelta: (t) => { acc += t; patch({ content: acc }); },
        onDone: (d) => patch({ cached: d.cached, promptVersionId: d.promptVersionId }),
        onError: (m) => patch({ content: acc || m }),
      });
      if (!streamed) {
        // стрим недоступен (напр. истёк токен) → обычный запрос с авто-рефрешем
        const r = await api.brainAsk(id, q, scope || undefined);
        patch({ content: r.answer, citations: r.citations, cached: r.cached, promptVersionId: r.promptVersionId });
      }
      if (canManage) api.aiUsage().then(setUsage).catch(() => undefined);
    } catch (e) {
      patch({ content: e instanceof ApiError ? e.message : 'Ошибка' });
    } finally { setThinking(false); }
  };
  const citeLabel = (c: any) => (c.sourceType === 'task' ? 'задача' : c.sourceType === 'comment' ? 'комментарий' : 'регламент') + (c.title ? `: ${c.title}` : '');
  // PromptOps P2: оценка ответа → аудит качества версии промпта
  const rate = async (idx: number, rating: 1 | -1) => {
    const m = chat[idx];
    if (!m?.promptVersionId || m.rated) return;
    setChat((c) => c.map((x, j) => (j === idx ? { ...x, rated: rating } : x)));
    api.promptFeedback({ promptVersionId: m.promptVersionId, rating }).catch(() => undefined);
  };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head"><h3><Icon name="book" size={18} /> База знаний</h3><button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button></div>
        <div className="dim" style={{ fontSize: 12 }}>
          В индексе: {stats?.chunks ?? '—'} фрагментов из {stats?.sources ?? '—'} источников (закрытые задачи, комментарии, регламенты).
          {usage && <> · ИИ-вызовов: {usage.totalCalls}, из кэша: {Math.round(usage.cacheHitRatio * 100)}%</>}
          {canManage && <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={reindex}>Переиндексировать всё</button>}
        </div>
        {canManage && (
          <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
            Google-доки из задач: {gd ? `${gd.byStatus.indexed ?? 0} в базе` : '—'}
            {gd?.byStatus.no_access ? `, нет доступа: ${gd.byStatus.no_access}` : ''}
            {gd?.byStatus.unsupported ? `, не поддержано: ${gd.byStatus.unsupported}` : ''}
            {gd?.byStatus.error ? `, ошибок: ${gd.byStatus.error}` : ''}
            <button className="btn btn-ghost btn-sm" style={{ marginLeft: 8 }} onClick={scanGdocs} disabled={gd?.scanning}>
              {gd?.scanning ? 'Сканирую…' : <><Icon name="link" size={14} /> Сканировать Google-доки</>}
            </button>
            <div style={{ fontSize: 11, opacity: 0.75 }}>Читаются только доки, открытые «по ссылке»; приватные помечаются «нет доступа».</div>
          </div>
        )}
        <div className="tabs">
          <button className={`tab ${tab === 'brain' ? 'active' : ''}`} onClick={() => setTab('brain')}>Спросить ИИ</button>
          <button className={`tab ${tab === 'search' ? 'active' : ''}`} onClick={() => setTab('search')}>Поиск</button>
          <button className={`tab ${tab === 'content' ? 'active' : ''}`} onClick={() => setTab('content')}>Содержимое</button>
          <button className={`tab ${tab === 'regs' ? 'active' : ''}`} onClick={() => setTab('regs')}>Регламенты</button>
        </div>
        {msg && <div className="dim">{msg}</div>}

        {tab === 'brain' && (
          <>
            <div className="brain-chat">
              {chat.length === 0 && (
                <EmptyState icon="sparkles" title="Спросите «корпоративный разум»"
                  hint="Как мы решали такую задачу раньше? Какой у нас регламент по возвратам? Ответ соберётся по архиву задач, комментариев и регламентов — со ссылками на источники." />
              )}
              {chat.map((m, i) => (
                <div key={i} className={`brain-msg brain-${m.role}`}>
                  {m.cached && <span className="badge badge-info" title="Ответ из кэша, без обращения к ИИ" style={{ marginBottom: 4 }}><Icon name="zap" size={11} /> из кэша</span>}
                  <div style={{ whiteSpace: 'pre-wrap' }}>{m.content}{m.role === 'assistant' && thinking && !m.content && <span className="dim">думаю…</span>}</div>
                  {m.citations && m.citations.length > 0 && (
                    <div className="brain-cites">
                      {m.citations.map((c, j) => <span key={j} className="badge" title={citeLabel(c)}>[{j + 1}] {citeLabel(c).slice(0, 40)}</span>)}
                    </div>
                  )}
                  {m.role === 'assistant' && m.promptVersionId && (
                    <div className="brain-rate" style={{ marginTop: 6, display: 'flex', gap: 6, alignItems: 'center' }}>
                      {m.rated ? (
                        <span className="dim" style={{ fontSize: 12 }}>Спасибо за оценку</span>
                      ) : (
                        <>
                          <span className="dim" style={{ fontSize: 12 }}>Ответ полезен?</span>
                          <button className="btn btn-ghost btn-sm" title="Полезно" onClick={() => rate(i, 1)}><Icon name="check" size={14} /></button>
                          <button className="btn btn-ghost btn-sm" title="Не полезно" onClick={() => rate(i, -1)}><Icon name="close" size={14} /></button>
                        </>
                      )}
                    </div>
                  )}
                </div>
              ))}
              {thinking && <div className="brain-msg brain-assistant dim">Думаю…</div>}
            </div>
            <div className="team-rate"><ScopeSelect /><span className="dim" style={{ fontSize: 12 }}>← искать ответ в этом разрезе</span></div>
            <div className="team-rate">
              <input className="input" placeholder="Ваш вопрос…" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && !thinking && sendAsk()} />
              <button className="btn btn-primary btn-sm" onClick={sendAsk} disabled={thinking}>Спросить</button>
            </div>
          </>
        )}

        {tab === 'search' && (
          <>
            <div className="team-rate"><ScopeSelect /></div>
            <div className="team-rate">
              <input className="input" placeholder="Спросите: как мы решали…?" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
              <button className="btn btn-primary btn-sm" onClick={doSearch} disabled={searching}>{searching ? '…' : 'Найти'}</button>
            </div>
            {hits && hits.length === 0 && (
              <EmptyState compact icon="search" title="Ничего не нашлось"
                hint="Поиск идёт по смыслу, а не по точным словам. Попробуйте переформулировать вопрос — или проверьте на вкладке «Содержимое», что нужные источники проиндексированы." />
            )}
            {hits?.map((h, i) => (
              <div key={i} className="team-row">
                <div className="team-head">
                  <span>
                    <span className="badge">{h.sourceType === 'task' ? 'задача' : h.sourceType === 'comment' ? 'комментарий' : 'регламент'}</span>
                    {h.projectName && <span className="badge" title="Проект"><Icon name="folder" size={12} /> {h.projectName}</span>} {h.title || '—'}
                  </span>
                  <span className="dim" style={{ fontSize: 12 }}>{Math.round((h.score ?? 0) * 100)}%</span>
                </div>
                <div className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{h.snippet}</div>
              </div>
            ))}
          </>
        )}

        {tab === 'content' && (
          <>
            <div className="team-rate">
              <ScopeSelect />
              <select className="input" style={{ maxWidth: 180 }} value={srcType} onChange={(e) => setSrcType(e.target.value)}>
                <option value="">Все типы</option>
                <option value="task">Задачи</option>
                <option value="comment">Комментарии</option>
                <option value="gdoc">Google-доки</option>
                <option value="regulation">Регламенты</option>
              </select>
            </div>
            <div className="team-rate">
              <input className="input" placeholder="Поиск по названию…" value={srcQ} onChange={(e) => setSrcQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadSources(true)} />
              <button className="btn btn-primary btn-sm" onClick={() => loadSources(true)}>Найти</button>
            </div>
            {sources.length === 0 && (
              <EmptyState compact icon="book" title="Пока ничего не проиндексировано"
                hint={srcQ.trim()
                  ? `По запросу «${srcQ.trim()}» источников нет.`
                  : 'Сюда попадают задачи, комментарии, регламенты и Google-документы после индексации. Именно на них опирается ИИ, отвечая на вопросы.'} />
            )}
            {sources.map((s) => {
              const key = `${s.sourceType}:${s.sourceId}`;
              const open = openSrc?.key === key;
              return (
                <div key={key} className="team-row">
                  <div className="team-head" style={{ cursor: 'pointer' }} onClick={() => viewSource(s.sourceType, s.sourceId)}>
                    <span>
                      <span className="badge">{srcTypeLabel(s.sourceType)}</span>
                      {s.projectName && <span className="badge" title="Проект"><Icon name="folder" size={12} /> {s.projectName}</span>} {s.title || '—'}
                    </span>
                    <span className="dim" style={{ fontSize: 12 }}>{open ? '▾' : '▸'} {s.chunks} фр.</span>
                  </div>
                  {open ? (
                    <div className="dim" style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 6, maxHeight: 320, overflow: 'auto' }}>
                      {openSrc?.data
                        ? <>
                            {openSrc.data.url && <div style={{ marginBottom: 4 }}><a href={openSrc.data.url} target="_blank" rel="noreferrer">{openSrc.data.url}</a></div>}
                            {openSrc.data.text || '(пусто)'}
                          </>
                        : 'Загрузка…'}
                    </div>
                  ) : (
                    <div className="dim" style={{ fontSize: 13, whiteSpace: 'pre-wrap' }}>{s.snippet}</div>
                  )}
                </div>
              );
            })}
            {srcHasMore && <button className="btn btn-ghost btn-sm" style={{ marginTop: 8 }} onClick={() => loadSources(false)}>Показать ещё</button>}
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
            {regs.length === 0 && (
              <EmptyState compact icon="book" title="Регламентов пока нет"
                hint={canManage
                  ? 'Добавьте первый — инструкции, правила, шаблоны ответов. ИИ будет опираться на них, отвечая команде.'
                  : 'Как только руководитель добавит инструкции и правила, они появятся здесь.'} />
            )}
          </>
        )}
      </aside>
    </div>
  );
}
