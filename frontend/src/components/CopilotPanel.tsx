import { useEffect, useState } from 'react';
import { api } from '../lib/api';

const LABEL: Record<string, string> = {
  reassign: 'Переназначить (перегруз)',
  deal_at_risk: 'Сделка под риском',
  draft_client_update: 'Черновик апдейта клиенту',
};

export function CopilotPanel({ onClose, onRefresh }: { onClose: () => void; onRefresh: () => void }) {
  const [recs, setRecs] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () => api.listRecommendations().then(setRecs).catch(() => undefined);
  useEffect(() => { load(); }, []);

  const scan = async () => {
    setBusy(true);
    try {
      await api.copilotScan();
      await load();
    } finally {
      setBusy(false);
    }
  };
  const accept = async (id: string) => { await api.acceptRecommendation(id); await load(); onRefresh(); };
  const dismiss = async (id: string) => { await api.dismissRecommendation(id); await load(); };

  return (
    <div className="drawer-overlay" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>Co-pilot · рекомендации</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>✕</button>
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={scan}>
          {busy ? '...' : '⟳ Сканировать'}
        </button>
        {recs.length === 0 && <div className="muted copilot-empty">Активных рекомендаций нет</div>}
        {recs.map((r) => (
          <div key={r.id} className="rec-row">
            <div className="rec-head">
              <span className="badge">{LABEL[r.type] ?? r.type}</span>
              {r.is_financial && <span className="badge badge-blocked">фин</span>}
            </div>
            <div className="dim rec-detail">
              {r.payload?.reason ?? ''}
              {r.payload?.draft ? `«${r.payload.draft}»` : ''}
            </div>
            <div className="rec-actions">
              <button className="btn btn-primary btn-sm" onClick={() => accept(r.id)}>Принять</button>
              <button className="btn btn-ghost btn-sm" onClick={() => dismiss(r.id)}>Отклонить</button>
            </div>
          </div>
        ))}
      </aside>
    </div>
  );
}
