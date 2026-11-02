import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { favorites, FAVORITES_CHANGED, initFavorites, toggleFavorite, type Favorite } from '../lib/favorites';
import { draftLabel, listDrafts, openDraft, removeDraft, TASK_DRAFT_CHANGED, type TaskDraft } from '../lib/task-draft';
import { CHAT_DRAFT_CHANGED, clearDraft, listChatDrafts } from '../lib/chat-drafts';
import './sidebar-lists.css';

// новый ключ (02.11): «Избранное» теперь свёрнуто по умолчанию — у всех, и у тех, кто уже раскрывал
const OPEN_KEY = 'qevo.sb-fav';

function readOpen(): Record<string, boolean> {
  try { return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') as Record<string, boolean>; } catch { return {}; }
}

/**
 * «Избранное» (#4713) в левом сайдбаре — под разделами, пунктом как остальные.
 * Черновики (#4715) — внутри «Избранного» (заказчик, 02.11), отдельной группой внизу.
 *
 * Отдельный модуль со своими стилями: грузится после первого экрана и не утяжеляет
 * его. По умолчанию свёрнуто; раскрыл — помнит этот браузер.
 */
export default function SidebarLists({ onGo }: { onGo: () => void }) {
  const { user } = useAuth();
  initFavorites(user?.uiPrefs);
  const [favs, setFavs] = useState<Favorite[]>(favorites);
  const [tasks, setTasks] = useState<TaskDraft[]>(() => listDrafts(user?.id));
  const [chats, setChats] = useState(() => listChatDrafts());
  const [open, setOpen] = useState<Record<string, boolean>>(readOpen);
  const route = useRoute();

  useEffect(() => {
    const f = () => setFavs([...favorites()]);
    const d = () => { setTasks(listDrafts(user?.id)); setChats(listChatDrafts()); };
    window.addEventListener(FAVORITES_CHANGED, f);
    window.addEventListener(TASK_DRAFT_CHANGED, d);
    window.addEventListener(CHAT_DRAFT_CHANGED, d);
    window.addEventListener('storage', d);
    return () => {
      window.removeEventListener(FAVORITES_CHANGED, f);
      window.removeEventListener(TASK_DRAFT_CHANGED, d);
      window.removeEventListener(CHAT_DRAFT_CHANGED, d);
      window.removeEventListener('storage', d);
    };
  }, [user?.id]);

  // по умолчанию свёрнуто (заказчик, 02.11)
  const isOpen = (k: string) => open[k] === true;
  const flip = (k: string) => {
    const next = { ...open, [k]: !isOpen(k) };
    setOpen(next);
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(next)); } catch { /* приватный режим */ }
  };

  const goFav = (f: Favorite) => {
    onGo();
    if (f.kind === 'project') navigate({ section: 'projects', projectId: f.id });
    else if (f.projectId) navigate({ section: 'projects', projectId: f.projectId, taskId: f.id });
  };
  const goChatDraft = async (key: string) => {
    const [kind, id] = key.split(':');
    onGo();
    if (kind === 'chat') navigate({ section: 'chat', chatId: id });
    else if (kind === 'task') {
      const t = await api.taskBrief(id).catch(() => null);
      if (t?.projectId) navigate({ section: 'projects', projectId: String(t.projectId), taskId: id });
    }
  };
  /*
    Черновики ответов в ветке (thread:…) без чата не открыть — их не показываем.
    Переписку, открытую сейчас, тоже: человек печатает в ней, и строка в сайдбаре
    повторяла каждую букву (жалоба 02.11). Черновик появится, когда он из неё уйдёт.
  */
  const here = new Set([route.chatId ? `chat:${route.chatId}` : '', route.taskId ? `task:${route.taskId}` : ''].filter(Boolean));
  const chatDrafts = chats.filter((c) => (c.key.startsWith('chat:') || c.key.startsWith('task:')) && !here.has(c.key)).slice(0, 10);
  const draftCount = tasks.length + chatDrafts.length;

  const total = favs.length + draftCount;
  const empty = <p className="sbl-empty">Отметьте звёздочкой проект или задачу — они будут здесь. Начатые и брошенные задачи и сообщения — тоже.</p>;

  return (
    <div className="sbl">
      <button type="button" className="nav-item" aria-expanded={isOpen('fav')} onClick={() => flip('fav')}>
        <Icon name="star" size={18} />
        <span className="nav-label">Избранное</span>
        {total > 0 && <span className="sbl-count">{total}</span>}
        <Icon name={isOpen('fav') ? 'chevron-down' : 'chevron-right'} size={14} />
      </button>
      {isOpen('fav') && (total === 0 ? empty : (
        <div className="sbl-body">
          {favs.length > 0 && (
            <ul className="sbl-list">
              {favs.map((f) => (
                <li key={`${f.kind}:${f.id}`} className="sbl-row">
                  <button type="button" className="sbl-item" onClick={() => goFav(f)} title={f.title}>
                    <Icon name={f.kind === 'project' ? 'folder' : 'check-circle'} size={15} />
                    <span className="sbl-text">{f.kind === 'task' ? `#${f.id} ` : ''}{f.title}</span>
                  </button>
                  <button type="button" className="sbl-x" onClick={() => toggleFavorite(f)} title="Убрать из избранного" aria-label={`Убрать «${f.title}» из избранного`}>
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {draftCount > 0 && (<>
            <div className="sbl-sub">Черновики · {draftCount}</div>
            <ul className="sbl-list">
              {tasks.map((d) => (
                <li key={d.id} className="sbl-row">
                  <button type="button" className="sbl-item" title="Продолжить задачу" onClick={() => { onGo(); openDraft(d, (projectId) => navigate({ section: 'projects', projectId })); }}>
                    <Icon name="edit" size={15} />
                    <span className="sbl-text">{draftLabel(d)}</span>
                  </button>
                  <button type="button" className="sbl-x" onClick={() => removeDraft(d.id)} title="Удалить черновик" aria-label="Удалить черновик задачи">
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
              {chatDrafts.map((c) => (
                <li key={c.key} className="sbl-row">
                  <button type="button" className="sbl-item" title="Вернуться к сообщению" onClick={() => void goChatDraft(c.key)}>
                    <Icon name="chat" size={15} />
                    <span className="sbl-text">{c.key.startsWith('task:') ? `Чат задачи #${c.key.slice(5)}: ` : ''}{c.text.replace(/\s+/g, ' ').slice(0, 80)}</span>
                  </button>
                  <button type="button" className="sbl-x" onClick={() => clearDraft(c.key)} title="Удалить черновик" aria-label="Удалить черновик сообщения">
                    <Icon name="close" size={12} />
                  </button>
                </li>
              ))}
            </ul>
          </>)}
        </div>
      ))}
    </div>
  );
}
