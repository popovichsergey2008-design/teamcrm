import { useTrialLimits } from '../lib/trial-limits';

/** «Осталось N из 20» рядом с микрофоном — задачи голосом в пробный период (#4779, п. 4.4). */
export function VoiceTrialLeft() {
  const t = useTrialLimits();
  if (!t?.trial) return null;
  const left = Math.max(0, t.voiceTasks.limit - t.voiceTasks.used);
  return (
    <span className={left ? 'dim' : 'error-text'} style={{ fontSize: 12, alignSelf: 'center' }} title="Задачи голосом в пробный период">
      {left ? `Осталось ${left} из ${t.voiceTasks.limit}` : 'Лимит задач голосом в пробный период исчерпан. Оплатите тариф, чтобы продолжить.'}
    </span>
  );
}
