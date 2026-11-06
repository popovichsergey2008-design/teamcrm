import { FormEvent, useState } from 'react';
import { Dialog } from '../ui/dialog';
import { Button } from '../ui/button';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../state/auth';
import { navigate } from '../../lib/router';
import { clearSignupTask, signupTask } from '../../lib/signup-intent';

/**
 * Знакомство после регистрации (#4779, п. 2): на первом шаге человек оставил только
 * почту и согласия, имя и название пространства спрашиваем здесь — уже внутри.
 * Задача из демо на сайте (п. 1.2) создаётся тут же, в новом проекте.
 * Закрыли крестиком — спросим при следующем входе: до тех пор стоят заглушки.
 */
export default function SetupNames({ onDone }: { onDone: () => void }) {
  const { user, reloadUser, renameOrg } = useAuth();
  const [fullName, setFullName] = useState('');
  const [space, setSpace] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!fullName.trim() || (user?.role === 'owner' && space.trim().length < 2)) { setError('Укажите имя и название пространства'); return; }
    setBusy(true); setError('');
    try {
      await api.updateProfile({ fullName: fullName.trim() });
      if (user?.role === 'owner') await renameOrg(space.trim());
      await api.saveUiPrefs({ setupNames: false });
      const task = signupTask();
      let go: { projectId: string; taskId: string } | null = null;
      if (task) {
        const r = await api.starterDemoTask(task).catch(() => null);
        clearSignupTask();
        if (r?.projectId && r.taskId) go = { projectId: r.projectId, taskId: r.taskId };
      }
      await reloadUser();
      onDone();
      if (go) navigate({ section: 'projects', projectId: go.projectId, taskId: go.taskId });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не получилось сохранить — попробуйте ещё раз');
    } finally { setBusy(false); }
  };

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onDone(); }} title="Давайте познакомимся" size="sm"
      description={signupTask() ? 'Задача из демо уже ждёт — создадим её в вашем первом проекте.' : undefined}>
      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="setup-name">Ваше имя</label>
          <input id="setup-name" className="input" value={fullName} onChange={(e) => setFullName(e.target.value)} maxLength={160} autoComplete="name" autoFocus required />
        </div>
        {user?.role === 'owner' && (
          <div className="field">
            <label htmlFor="setup-space">Название пространства</label>
            <input id="setup-space" className="input" value={space} onChange={(e) => setSpace(e.target.value)} maxLength={160} required aria-describedby="setup-space-hint" />
            <span id="setup-space-hint" className="dim" style={{ fontSize: 12 }}>Общая рабочая зона команды. Обычно указывают название компании.</span>
          </div>
        )}
        {error && <div className="error-text">{error}</div>}
        <Button type="submit" disabled={busy}>{busy ? 'Сохраняю…' : 'Продолжить'}</Button>
      </form>
    </Dialog>
  );
}
