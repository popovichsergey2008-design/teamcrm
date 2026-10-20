import { useEffect, useState } from 'react';
import { api } from '../../lib/api';

/**
 * Проект группы/канала (20.10): задачи из переписки ИИ ставит сразу в него.
 * Список — те проекты, что человек видит; архивные не предлагаем.
 */
export function ChatProjectSelect({ value, onChange, id }: { value: string; onChange: (projectId: string) => void; id?: string }) {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    let alive = true;
    api.listProjects().then((list) => { if (alive) setProjects(list.map((p) => ({ id: String(p.id), name: p.name }))); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return (
    <select id={id} className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label="Проект чата">
      <option value="">Без проекта — ИИ определит по тексту</option>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      {value && !projects.some((p) => p.id === value) && <option value={value}>Текущий проект</option>}
    </select>
  );
}
