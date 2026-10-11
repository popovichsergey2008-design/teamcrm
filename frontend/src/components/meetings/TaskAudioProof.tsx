import { useCallback, useEffect, useState } from 'react';
import { Icon } from '../Icon';
import { AudioClip } from './AudioClip';
import { api, ApiError, type TaskAudioProof as Proof } from '../../lib/api';
import { navigate } from '../../lib/router';
import { getSocket } from '../../lib/socket';
import { confirmAction } from '../ui/dialog';

const stamp = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * «▶ Послушать контекст · 15 сек» в карточке задачи (ТЗ-25, §18, §32): исполнитель
 * слышит, как поручение прозвучало на самом деле, — оригинальный голос, не пересказ.
 * Нет фрагмента — ничего не рисуем: обычная задача остаётся обычной. Грузится лениво.
 */
export default function TaskAudioProof({ taskId, canEdit }: { taskId: string; canEdit: boolean }) {
  const [proof, setProof] = useState<Proof | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(() => api.taskAudioProof(taskId).then(setProof).catch(() => setProof(null)), [taskId]);
  useEffect(() => { void load(); }, [load]);
  // фрагмент вырезается фоном — открытая карточка узнаёт о готовности сама
  useEffect(() => {
    const socket = getSocket();
    const on = (p: { taskId: string }) => { if (String(p.taskId) === String(taskId)) void load(); };
    socket.on('task.audio_proof', on);
    return () => { socket.off('task.audio_proof', on); };
  }, [taskId, load]);

  if (!proof || proof.status === 'revoked') return null;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true); setErr('');
    try { await fn(); await load(); } catch (e) { setErr(e instanceof ApiError ? e.message : 'Не получилось'); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!(await confirmAction({ title: 'Убрать аудиоконтекст?', description: 'Фрагмент записи удалится из задачи. Сама задача останется.', confirmLabel: 'Убрать', danger: true }))) return;
    await act(() => api.taskAudioProofRevoke(taskId));
  };

  return (
    <div className="tv2-proof">
      <div className="tv2-proof-head">
        <Icon name="mic" size={13} />
        <span>Источник: {proof.meeting.title}{proof.meeting.happenedAt ? ` · ${new Date(proof.meeting.happenedAt).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })}` : ''} · {stamp(proof.anchorSec)}</span>
        {proof.canOpenMeeting && (
          <button type="button" className="link-btn" onClick={() => navigate(`/meetings/${encodeURIComponent(proof.meeting.id)}?t=${Math.round(proof.anchorSec)}`)}>
            Открыть созвон с {stamp(proof.anchorSec)}
          </button>
        )}
      </div>
      {proof.status === 'ready' && proof.playback && (
        <AudioClip url={proof.playback.url} start={0} end={proof.durationSec} label={`Послушать контекст · ${proof.durationSec} сек`} />
      )}
      {proof.status === 'pending' && <div className="dim tv2-proof-note">Готовлю фрагмент записи…</div>}
      {proof.status === 'failed' && (
        <div className="dim tv2-proof-note">
          Аудиоконтекст временно недоступен.{' '}
          <button type="button" className="link-btn" disabled={busy} onClick={() => void act(() => api.taskAudioProofReprocess(taskId))}>Повторить обработку</button>
        </div>
      )}
      {proof.quote && <blockquote className="tv2-proof-quote">{proof.quote}</blockquote>}
      {canEdit && proof.status !== 'pending' && (
        <div className="tv2-proof-tools">
          <button type="button" className="link-btn" disabled={busy} onClick={() => void act(() => api.taskAudioProofAdjust(taskId, { startDelta: -5 }))}>−5 сек</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => void act(() => api.taskAudioProofAdjust(taskId, { endDelta: 10 }))}>+10 сек</button>
          <button type="button" className="link-btn" disabled={busy} onClick={() => void remove()}>Убрать аудио</button>
        </div>
      )}
      {err && <div className="error-text">{err}</div>}
    </div>
  );
}
