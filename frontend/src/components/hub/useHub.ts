import { useCallback, useEffect, useRef, useState } from 'react';
import { hubApi, type HubView } from '../../lib/hub-api';
import { getSocket } from '../../lib/socket';
import { errText } from './parts';

/**
 * Данные Инфоцентра одного проекта и их живое обновление.
 *
 * Сервер шлёт `hub.changed` в комнату проекта при любой правке и после сбора
 * библиотекаря. В комнату доску уже подписал BoardPage (project.subscribe), поэтому
 * здесь только слушаем. Пачку событий подряд (сбор кладёт десяток записей) склеиваем
 * в одно перечитывание.
 */
export function useHub(projectId: string) {
  const [view, setView] = useState<HubView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const current = useRef(projectId);
  current.current = projectId;

  const reload = useCallback(() => {
    const id = projectId;
    return hubApi.view(id)
      .then((v) => { if (current.current === id) { setView(v); setError(''); } })
      .catch((e) => { if (current.current === id) setError(errText(e, 'Инфоцентр не загрузился')); })
      .finally(() => { if (current.current === id) setLoading(false); });
  }, [projectId]);

  useEffect(() => {
    setView(null); setLoading(true); setError('');
    void reload();
  }, [reload]);

  useEffect(() => {
    const socket = getSocket();
    let timer: number | undefined;
    const onChanged = (p: { projectId?: string | number }) => {
      if (String(p?.projectId) !== String(projectId)) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => void reload(), 300);
    };
    socket.on('hub.changed', onChanged);
    return () => { window.clearTimeout(timer); socket.off('hub.changed', onChanged); };
  }, [projectId, reload]);

  return { view, setView, error, loading, reload };
}
