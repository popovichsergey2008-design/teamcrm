import { useEffect, useState } from 'react';
import { apiUrl } from '../lib/origin';
import './qa-switch.css';

/**
 * Объявление техотдела для всех (обновление, техработы). Спрашиваем при открытии и раз
 * в 5 минут; ответ без входа — плашку видно и на экране входа. Исчезает сама по сроку.
 */
export default function SystemNoticeBar() {
  const [n, setN] = useState<{ id: string; text: string } | null>(null);
  const [hidden, setHidden] = useState('');
  useEffect(() => {
    const load = () => fetch(apiUrl('/api/system/notice'))
      .then((r) => r.json())
      .then((j) => setN(j?.data ?? null))
      .catch(() => undefined);
    load();
    const t = window.setInterval(load, 5 * 60_000);
    return () => window.clearInterval(t);
  }, []);
  if (!n || hidden === n.id) return null;
  return (
    <div className="qa-bar sys-notice" role="status">
      <span className="qa-bar-text">{n.text}</span>
      <button type="button" className="qa-bar-back" onClick={() => setHidden(n.id)}>Понятно</button>
    </div>
  );
}
