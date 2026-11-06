import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { useAuth } from '../state/auth';
import { api } from '../lib/api';
import { navigate, useRoute } from '../lib/router';
import { draftLabel, listDrafts, openDraft, TASK_DRAFT_CHANGED } from '../lib/task-draft';
import { CHAT_DRAFT_CHANGED, listChatDrafts } from '../lib/chat-drafts';
import './sidebar-lists.css';

/** Последняя открытая задача — чтобы вернуть к ней, если ушли, не закончив (#4764). */
const LAST_KEY = 'qevo.continue.task';
const FRESH_MS = 12 * 3600_000;

interface Item { key: string; icon: 'clock' | 'edit' | 'chat' | 'check-circle'; text: string; hint: string; go: () => void }

/**
 * «Продолжить работу» (#4764): блок вверху сайдбара — только когда есть незавершённое:
 * идёт таймер по задаче, начата и не поставлена задача, не дописано сообщение, открыта и
 * не закончена своя задача. Каждый пункт возвращает ровно туда, где человек был. Пусто —
 * блока нет: никаких «случайных предложений».
 */
export default function ContinueWork({ onGo }: { onGo: () => void }) {
  const { user } = useAuth();
  const route = useRoute();
  const [items, setItems] = useState<Item[]>([]);

  // запоминаем открытую задачу: вернуться к ней — первый смысл блока
  useEffect(() => {
    if (route.section !== 'projects' || !route.taskId || !route.projectId) return;
    try { localStorage.setItem(LAST_KEY, JSON.stringify({ taskId: route.taskId, projectId: route.projectId, at: Date.now() })); } catch { /* без хранилища — без пункта */ }
  }, [route.section, route.taskId, route.projectId]);

  useEffect(() => {
    let alive = true;
    const build = async () => {
      const out: Item[] = [];
      const here = route.taskId ? String(route.taskId) : null;
      // 1. таймер идёт — работа над задачей не закончена
      const timer = await api.myTimer().catch(() => null);
      if (timer?.taskId && timer.taskId !== here) {
        const t = await api.taskBrief(timer.taskId).catch(() => null);
        if (t) out.push({ key: `timer${t.id}`, icon: 'clock', text: `#${t.id} ${t.title}`, hint: 'Таймер идёт', go: () => navigate({ section: 'projects', projectId: t.projectId, taskId: t.id }) });
      }
      // 2. начатая и не поставленная задача — открыть с тем же текстом
      const draft = listDrafts(user?.id)[0];
      if (draft) out.push({ key: `draft${draft.id}`, icon: 'edit', text: draftLabel(draft), hint: 'Задача не поставлена', go: () => openDraft(draft, (projectId) => navigate({ section: 'projects', projectId })) });
      // 3. недописанное сообщение — в тот же чат, текст уже в поле
      const chat = listChatDrafts().find((c) => c.key.startsWith('chat:') && c.key !== `chat:${route.chatId}` && c.text.replace(/[^\p{L}\p{N}]+/gu, '').length >= 3);
      if (chat) {
        const id = chat.key.slice(5);
        out.push({ key: chat.key, icon: 'chat', text: chat.text.trim().slice(0, 60), hint: id === 'anthill' ? 'Вопрос QEVO Bot не отправлен' : 'Сообщение не отправлено', go: () => navigate({ section: 'chat', chatId: id }) });
      }
      // 4. своя открытая задача, к которой не вернулись
      try {
        const last = JSON.parse(localStorage.getItem(LAST_KEY) ?? 'null') as { taskId: string; projectId: string; at: number } | null;
        if (last && Date.now() - last.at < FRESH_MS && last.taskId !== here && !out.some((o) => o.key === `timer${last.taskId}`)) {
          const t = await api.taskBrief(last.taskId).catch(() => null);
          if (t && !t.closed && String(t.assigneeId ?? '') === String(user?.id ?? '')) {
            out.push({ key: `task${t.id}`, icon: 'check-circle', text: `#${t.id} ${t.title}`, hint: 'Вы работали над задачей', go: () => navigate({ section: 'projects', projectId: t.projectId, taskId: t.id }) });
          }
        }
      } catch { /* нет записи — нет пункта */ }
      if (alive) setItems(out.slice(0, 3));
    };
    void build();
    const re = () => { void build(); };
    window.addEventListener(TASK_DRAFT_CHANGED, re);
    window.addEventListener(CHAT_DRAFT_CHANGED, re);
    return () => { alive = false; window.removeEventListener(TASK_DRAFT_CHANGED, re); window.removeEventListener(CHAT_DRAFT_CHANGED, re); };
  }, [user?.id, route.taskId, route.chatId]);

  if (!items.length) return null;
  return (
    <div className="sbl-continue" aria-label="Продолжить работу">
      <div className="sbl-continue-head"><Icon name="arrow-right" size={14} /> Продолжить работу</div>
      <ul className="sbl-list">
        {items.map((it) => (
          <li key={it.key}>
            <button type="button" className="sbl-item" title={`${it.hint}: ${it.text}`} onClick={() => { onGo(); it.go(); }}>
              <Icon name={it.icon} size={15} />
              {/* #4799 NAV02: у каждой строки — почему она здесь: таймер, черновик, недавняя задача */}
              <span className="sbl-two">
                <span className="sbl-text">{it.text}</span>
                <span className="sbl-why">{it.hint}</span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
