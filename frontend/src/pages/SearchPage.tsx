import { useEffect, useRef, useState } from 'react';
import { Icon, type IconName } from '../components/Icon';
import { request } from '../lib/api';
import { navigate, type Route } from '../lib/router';
import type { SearchResults } from '../types';

type Tab = 'all' | 'tasks' | 'projects' | 'chats' | 'messages' | 'meetings' | 'people' | 'docs';
const TABS: { key: Tab; label: string }[] = [
  { key: 'all', label: 'Все' }, { key: 'tasks', label: 'Задачи' }, { key: 'projects', label: 'Проекты' },
  { key: 'chats', label: 'Чаты' }, { key: 'messages', label: 'Сообщения' }, { key: 'meetings', label: 'Встречи' },
  { key: 'people', label: 'Люди' }, { key: 'docs', label: 'Регламенты' },
];
const PAGE = 30;

interface Row { key: string; icon: IconName; title: string; hint?: string; snippet?: string | null; to: Route }

const date = (iso: string) => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' });

/** Находки раздела → строки списка: одна разметка на все разделы. */
function rowsOf(r: SearchResults, tab: Exclude<Tab, 'all'>): Row[] {
  switch (tab) {
    case 'tasks': return r.tasks.map((t) => ({
      key: `t${t.id}`, icon: 'check-circle', title: `№${t.id} ${t.title}`,
      hint: [t.project_name, t.closed ? 'завершена' : t.column_name, t.assignee_name, t.deadline_at ? `срок ${date(t.deadline_at)}` : null].filter(Boolean).join(' · '),
      snippet: t.description ? `в описании: ${t.description}` : null,
      to: { section: 'projects', projectId: String(t.project_id), taskId: String(t.id) },
    }));
    case 'projects': return r.projects.map((p) => ({
      key: `p${p.id}`, icon: 'board', title: p.name, hint: p.status === 'archived' ? 'в архиве' : undefined,
      to: { section: 'projects', projectId: String(p.id) },
    }));
    case 'chats': return r.chats.map((c) => ({
      key: `c${c.id}`, icon: 'chat', title: c.title ?? 'Чат', hint: c.kind === 'direct' ? 'личный' : undefined,
      to: { section: 'chat', chatId: String(c.id) },
    }));
    case 'messages': return r.messages.map((m) => ({
      key: `m${m.id}`, icon: 'chat', title: m.body,
      hint: [m.author_name, m.chat_title ?? 'личный чат', date(m.created_at)].filter(Boolean).join(' · '),
      to: { section: 'chat', chatId: String(m.chat_id) },
    }));
    case 'meetings': return (r.meetings ?? []).map((m) => ({
      key: `mt${m.id}`, icon: 'video', title: m.title, hint: date(m.happened_at),
      to: { section: 'chat', view: 'meetings', meetingId: String(m.id) },
    }));
    case 'people': return r.people.map((p) => ({
      key: `u${p.id}`, icon: 'user', title: p.full_name, hint: [p.position, p.email].filter(Boolean).join(' · '),
      to: { section: 'settings', tab: 'team' },
    }));
    case 'docs': return r.docs.map((d) => ({
      key: `d${d.id}`, icon: 'book', title: d.title, to: { section: 'settings', tab: 'knowledge' },
    }));
  }
}

/**
 * Страница поиска (#4922): всё, что нашлось по запросу, — по разделам, а не шесть строк
 * палитры. Слова ищутся в любом порядке, «#123» — номер задачи, у задачи, найденной по
 * описанию, виден кусок описания. «Показать ещё» догружает раздел порциями.
 */
export function SearchPage({ query }: { query: string }) {
  const [q, setQ] = useState(query);
  const [tab, setTab] = useState<Tab>('all');
  const [res, setRes] = useState<SearchResults | null>(null);
  const [more, setMore] = useState<Row[]>([]);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => { setQ(query); }, [query]);
  useEffect(() => { input.current?.focus(); }, []);

  useEffect(() => {
    const s = query.trim();
    setMore([]); setDone(false);
    if (s.length < 2 && !/^\d$/.test(s)) { setRes(null); return; }
    let alive = true;
    setBusy(true);
    const url = tab === 'all' ? `/search?page=1&q=${encodeURIComponent(s)}` : `/search?type=${tab}&q=${encodeURIComponent(s)}`;
    request<SearchResults>('GET', url)
      .then((r) => { if (alive) { setRes(r); if (tab !== 'all' && rowsOf(r, tab).length < PAGE) setDone(true); } })
      .catch(() => { if (alive) setRes(null); })
      .finally(() => { if (alive) setBusy(false); });
    return () => { alive = false; };
  }, [query, tab]);

  const submit = () => { const s = q.trim(); if (s) navigate({ section: 'search', view: s }, { replace: true }); };
  const loadMore = async () => {
    if (tab === 'all' || !res) return;
    setBusy(true);
    try {
      const offset = rowsOf(res, tab).length + more.length;
      const r = await request<SearchResults>('GET', `/search?type=${tab}&offset=${offset}&q=${encodeURIComponent(query.trim())}`);
      const rows = rowsOf(r, tab);
      setMore((m) => [...m, ...rows]);
      if (rows.length < PAGE) setDone(true);
    } finally { setBusy(false); }
  };

  const sections = TABS.filter((t) => t.key !== 'all').map((t) => ({ ...t, rows: res ? rowsOf(res, t.key as Exclude<Tab, 'all'>) : [] }));
  const total = sections.reduce((n, x) => n + x.rows.length, 0);
  const Item = ({ r }: { r: Row }) => (
    <li>
      <button type="button" className="palette-item" style={{ width: '100%', textAlign: 'left' }} onClick={() => navigate(r.to)}>
        <Icon name={r.icon} size={15} />
        <span style={{ display: 'grid', gap: 2, minWidth: 0 }}>
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
          {r.hint && <span className="dim" style={{ fontSize: 'var(--fs-sm)' }}>{r.hint}</span>}
          {r.snippet && <span className="dim" style={{ fontSize: 'var(--fs-sm)' }}>{r.snippet}</span>}
        </span>
      </button>
    </li>
  );

  return (
    <div style={{ maxWidth: 920, margin: '0 auto', padding: '20px 16px', display: 'grid', gap: 14 }}>
      <h1 style={{ margin: 0, fontSize: 'var(--fs-xl, 22px)' }}>Поиск</h1>
      <form onSubmit={(e) => { e.preventDefault(); submit(); }} style={{ display: 'flex', gap: 8 }}>
        <input ref={input} className="ui-input" style={{ flex: 1 }} value={q} onChange={(e) => setQ(e.target.value)}
          placeholder="Задача, номер (#123), чат, сообщение, встреча, человек…" aria-label="Что найти" />
        <button type="submit" className="ui-btn ui-btn-primary"><Icon name="search" size={15} /> Найти</button>
      </form>
      <div className="kv2-seg" role="tablist" aria-label="Раздел поиска" style={{ flexWrap: 'wrap' }}>
        {TABS.map((t) => {
          const n = t.key === 'all' ? total : sections.find((x) => x.key === t.key)?.rows.length ?? 0;
          return (
            <button key={t.key} type="button" role="tab" className="kv2-seg-btn" aria-pressed={tab === t.key} aria-selected={tab === t.key} onClick={() => setTab(t.key)}>
              {t.label}{tab === 'all' && res && n ? ` · ${n}${n >= PAGE ? '+' : ''}` : ''}
            </button>
          );
        })}
      </div>
      {!query.trim() && <div className="dim">Введите запрос. Слова можно писать в любом порядке, «ё» и «е» не различаются.</div>}
      {busy && !res && <div className="dim">Ищу…</div>}
      {res && tab === 'all' && !total && <div className="dim">По запросу «{query}» ничего не нашлось. Попробуйте другое слово или номер задачи.</div>}
      {res && tab === 'all' && sections.filter((x) => x.rows.length).map((x) => (
        <section key={x.key} style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <strong>{x.label}</strong>
            {x.rows.length >= PAGE && <button type="button" className="cal-due-link" onClick={() => setTab(x.key)}>Все {x.label.toLowerCase()} →</button>}
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{x.rows.slice(0, 8).map((r) => <Item key={r.key} r={r} />)}</ul>
          {x.rows.length > 8 && <button type="button" className="cal-due-link" style={{ justifySelf: 'start' }} onClick={() => setTab(x.key)}>Ещё {x.rows.length - 8}{x.rows.length >= PAGE ? '+' : ''} →</button>}
        </section>
      ))}
      {res && tab !== 'all' && (() => {
        const rows = [...rowsOf(res, tab), ...more];
        if (!rows.length) return <div className="dim">В разделе «{TABS.find((t) => t.key === tab)?.label}» по запросу «{query}» ничего нет.</div>;
        return (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{rows.map((r) => <Item key={r.key} r={r} />)}</ul>
            {!done && <button type="button" className="ui-btn ui-btn-outline ui-btn-sm" style={{ justifySelf: 'start' }} disabled={busy} onClick={() => void loadMore()}>{busy ? 'Загружаю…' : 'Показать ещё'}</button>}
          </>
        );
      })()}
    </div>
  );
}
