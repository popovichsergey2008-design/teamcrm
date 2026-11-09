import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { draftLabel, listDrafts, openDraft, TASK_DRAFT_CHANGED } from '../lib/task-draft';
import { CHAT_DRAFT_CHANGED, listChatDrafts } from '../lib/chat-drafts';
import './sidebar-lists.css';

interface Item { key: string; icon: 'clock' | 'edit' | 'chat'; text: string; hint: string; go: () => void; timer?: { taskId: string; startedAt: string } }

/** 00:42:15 — сколько идёт таймер. */
function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor((s % 3600) / 60))}:${p(s % 60)}`;
}

/**
 * «Продолжить работу» (#4764; #4807 §5, п. 3): карточка 44 px вверху меню — только при
 * идущем таймере или начатом черновике. Таймер идёт в реальном времени, ⏸ — пауза;
 * до трёх записей, вторая и третья — по раскрытию. Пусто — блока нет.
 */
export default function ContinueWork({ onGo }: { onGo: () => void }) {
  const { user } = useAuth();
  const route = useRoute();
  const [items, setItems] = useState<Item[]>([]);
  const [more, setMore] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [rev, setRev] = useState(0);

  useEffect(() => {
    let alive = true;
    const build = async () => {
      const out: Item[] = [];
      // 1. таймер идёт — работа над задачей не закончена
      const timer = await api.myTimer().catch(() => null);
      if (timer?.taskId && !timer.stoppedAt) {
        const t = await api.taskBrief(timer.taskId).catch(() => null);
        if (t) out.push({ key: `timer${t.id}`, icon: 'clock', text: `#${t.id} ${t.title}`, hint: 'Таймер идёт', timer: { taskId: String(t.id), startedAt: timer.startedAt }, go: () => navigate({ section: 'projects', projectId: t.projectId, taskId: t.id }) });
      }
      // 2. начатая и не поставленная задача — открыть с тем же текстом
      const draft = listDrafts(user?.id)[0];
      if (draft) out.push({ key: `draft${draft.id}`, icon: 'edit', text: draftLabel(draft), hint: 'Черновик задачи', go: () => openDraft(draft, (projectId) => navigate({ section: 'projects', projectId })) });
      // 3. недописанное сообщение — в тот же чат, текст уже в поле
      const chat = listChatDrafts().find((c) => c.key.startsWith('chat:') && c.key !== `chat:${route.chatId}` && c.text.replace(/[^\p{L}\p{N}]+/gu, '').length >= 3);
      if (chat) {
        const id = chat.key.slice(5);
        out.push({ key: chat.key, icon: 'chat', text: chat.text.trim().slice(0, 60), hint: id === 'anthill' ? 'Вопрос QEVO Bot не отправлен' : 'Сообщение не отправлено', go: () => navigate({ section: 'chat', chatId: id }) });
      }
      if (alive) setItems(out.slice(0, 3));
    };
    void build();
    const re = () => { void build(); };
    window.addEventListener(TASK_DRAFT_CHANGED, re);
    window.addEventListener(CHAT_DRAFT_CHANGED, re);
    window.addEventListener('teamcrm:tasks-changed', re);
    return () => {
      alive = false;
      window.removeEventListener(TASK_DRAFT_CHANGED, re);
      window.removeEventListener(CHAT_DRAFT_CHANGED, re);
      window.removeEventListener('teamcrm:tasks-changed', re);
    };
  }, [user?.id, route.taskId, route.chatId, rev]);

  // живой таймер — раз в секунду, только пока он есть
  const running = items.some((i) => i.timer);
  useEffect(() => {
    if (!running) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);

  if (!items.length) return null;
  const pause = async (taskId: string) => {
    await api.stopTimer(taskId).catch(() => undefined);
    window.dispatchEvent(new Event('teamcrm:tasks-changed'));
    setRev((r) => r + 1);
  };
  const row = (it: Item, first: boolean) => (
    <li key={it.key} className={first ? 'sbl-cw-card' : undefined}>
      {it.timer
        ? <button type="button" className="sbl-cw-pause" onClick={() => void pause(it.timer!.taskId)} title="Пауза — остановить таймер" aria-label="Остановить таймер"><Icon name="pause" size={14} /></button>
        : <span className="sbl-cw-ico" aria-hidden="true"><Icon name={it.icon} size={14} /></span>}
      <button type="button" className="sbl-item sbl-cw-go" title={`${it.hint}: ${it.text}`} onClick={() => { onGo(); it.go(); }}>
        <span className="sbl-two">
          <span className="sbl-text">{it.text}</span>
          <span className="sbl-why">
            {it.timer ? <><span className="sbl-cw-dot" aria-hidden="true">●</span> {clock(now - new Date(it.timer.startedAt).getTime())} · продолжить</> : `${it.hint} · продолжить`}
          </span>
        </span>
      </button>
    </li>
  );
  return (
    <div className="sbl-continue" aria-label="Продолжить работу">
      <ul className="sbl-list">
        {row(items[0], true)}
        {more && items.slice(1).map((it) => row(it, false))}
      </ul>
      {items.length > 1 && (
        <button type="button" className="sbl-cw-more" onClick={() => setMore((v) => !v)} aria-expanded={more}>
          {more ? 'Свернуть' : `Ещё ${items.length - 1}`}
        </button>
      )}
    </div>
  );
}
