import { api } from './api';
import { navigate } from './router';
import { confirmAction } from '../components/ui/dialog';

const hm = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : '');

/**
 * Перед звонком одному человеку — его статус (#4782, п. 8): статус сразу объясняет,
 * можно ли звонить и когда ждать ответа. «Занят» — предупредить, можно продолжить;
 * «На созвоне» и «Обед» — звонок придёт без звука; «Глубокий фокус» — не дойдёт,
 * лучше оставить сообщение. Звонок нескольким — без вопросов. Вернёт, звонить ли.
 */
export async function precheckCall(memberIds: string[], meId: string | null | undefined): Promise<boolean> {
  const others = [...new Set(memberIds.map(String))].filter((id) => id !== String(meId ?? ''));
  if (others.length !== 1) return true;
  const p = await api.teamPulse().then((rows) => rows.find((r) => String(r.userId) === others[0]) ?? null).catch(() => null);
  if (!p) return true;
  const first = p.fullName.split(' ')[0] || p.fullName;
  if (p.status === 'deep_focus') {
    const leave = await confirmAction({
      title: `${first} в глубоком фокусе${p.until ? ` до ${hm(p.until)}` : ''}`,
      description: 'Обычный звонок в фокусе не звонит — он придёт в сводку после фокуса. Оставьте сообщение, а по-настоящему срочное — «Срочно связаться» в личном чате.',
      confirmLabel: 'Оставить сообщение',
    });
    if (leave) {
      const dm = await api.openDm(others[0]).catch(() => null);
      if (dm) navigate({ section: 'chat', chatId: String(dm.id) });
    }
    return false;
  }
  if (p.status === 'do_not_disturb') {
    return confirmAction({ title: `${first}: занят`, description: 'Человек просил не беспокоить. Позвонить всё равно?', confirmLabel: 'Позвонить' });
  }
  if (p.status === 'in_meeting') {
    return confirmAction({
      title: `${first} на созвоне`,
      description: 'Второй звонок придёт без звука. Может, лучше оставить сообщение?',
      confirmLabel: 'Всё равно позвонить',
    });
  }
  if (p.status === 'break') {
    return confirmAction({
      title: `${first}: обед / перерыв${p.until ? ` до ${hm(p.until)}` : ''}`,
      description: 'Звонок придёт без звука — ответит, когда вернётся.',
      confirmLabel: 'Позвонить',
    });
  }
  return true;
}
