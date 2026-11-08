/**
 * «Черновики для утренней планерки я уже добавил в ваши задачи» (#1525, фича 6) — 1 в 1.
 *
 * Пункты планерки из утреннего брифа ложатся в «Черновики» руководителя — туда же, где
 * его начатые задачи: на доске ничего не появляется само, а поставить пункт задачей —
 * одним нажатием из «Черновиков». Каждый пункт раскладывается один раз: удалённый
 * черновик не возвращается при следующем открытии.
 */
import { api } from './api';
import { listDrafts, newDraftId, saveDraft } from './task-draft';

const doneKey = (uid: string) => `qevo.brief.drafts:${uid}`;
const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

interface BriefDraft { ref: string; title: string; description: string; projectId: string; taskId: string | null }

export async function importBriefDrafts(userId: string | undefined): Promise<number> {
  if (!userId) return 0;
  let done: string[] = [];
  try { done = JSON.parse(localStorage.getItem(doneKey(userId)) ?? '[]') as string[]; } catch { done = []; }
  const items = await api.proposals({}).then((r) => r.items).catch(() => []);
  const today = todayLocal();
  const existing = new Set(listDrafts(userId).map((d) => d.title));
  let n = 0;
  for (const p of items) {
    if (p.skill !== 'brief' || !p.createdAt) continue;
    const created = new Date(p.createdAt);
    const day = `${created.getFullYear()}-${String(created.getMonth() + 1).padStart(2, '0')}-${String(created.getDate()).padStart(2, '0')}`;
    if (day !== today) continue;
    for (const d of (p.payload?.drafts ?? []) as BriefDraft[]) {
      const key = `${p.id}:${d.ref}`;
      if (d.taskId || done.includes(key) || existing.has(d.title)) continue;
      saveDraft({
        id: newDraftId(), kind: 'form', userId: String(userId), projectId: String(d.projectId), columnId: '', columnName: '',
        title: d.title, description: d.description, assigneeId: String(userId), managerId: String(userId), priority: 'normal',
        deadline: `${today}T18:00`, estimate: '', directions: [], requiresApproval: false, savedAt: new Date().toISOString(),
      });
      done.push(key);
      n++;
    }
  }
  try { localStorage.setItem(doneKey(userId), JSON.stringify(done.slice(-200))); } catch { /* без хранилища — разложим снова, дубли отсекаются по названию */ }
  return n;
}
