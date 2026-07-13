import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

const STATUS: Record<string, string> = { active: '⭐ активная', testing: '🧪 тест', draft: 'черновик', deprecated: 'снята' };

/** PromptOps: версии промптов ИИ (owner/manager). «Git для инструкций ИИ»: правка/откат без релиза. */
export function PromptsSection() {
  const [templates, setTemplates] = useState<any[]>([]);
  const [key, setKey] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);         // { key, title, customized, versions[] }
  const [metrics, setMetrics] = useState<Record<number, any>>({});
  const [body, setBody] = useState('');
  const [model, setModel] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };

  const loadTemplates = () => api.prompts().then((t) => { setTemplates(t); if (!key && t[0]) setKey(t[0].key); }).catch(() => undefined);
  useEffect(() => {
    loadTemplates();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadVersions = (k: string) => {
    api.promptVersions(k).then((d) => {
      setData(d);
      const active = d.versions.find((v: any) => v.status === 'active') ?? d.versions[0];
      setBody(active?.body ?? ''); setModel(active?.model ?? ''); setNote('');
    }).catch(() => setData(null));
    api.promptMetrics(k).then((m) => {
      const map: Record<number, any> = {};
      for (const r of m.byVersion) map[r.version] = r;
      setMetrics(map);
    }).catch(() => setMetrics({}));
  };
  useEffect(() => {
    if (key) loadVersions(key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const vars = Array.from(new Set([...body.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)].map((m) => m[1])));

  const saveVersion = async () => {
    if (!key || !body.trim()) return flash('Введите текст промпта');
    setBusy(true);
    try {
      await api.promptCreateVersion(key, { body: body.trim(), model: model.trim() || undefined, note: note.trim() || undefined });
      flash('Создана новая версия (черновик). Нажмите «Сделать активной», чтобы применить.');
      loadVersions(key); loadTemplates();
    } catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
    finally { setBusy(false); }
  };

  const activate = async (v: number) => {
    if (!key) return;
    try { await api.promptActivate(key, v); flash(`Версия ${v} активна`); loadVersions(key); loadTemplates(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const deprecate = async (v: number) => {
    if (!key) return;
    try { await api.promptDeprecate(key, v); flash(`Версия ${v} снята`); loadVersions(key); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const startAb = async (v: number) => {
    if (!key) return;
    const raw = window.prompt('Доля трафика на этот вариант (B), % — 1..99:', '20');
    if (raw === null) return;
    const split = Number(raw);
    if (!Number.isInteger(split) || split < 1 || split > 99) return flash('Нужно целое 1..99');
    try { await api.promptAbTest(key, v, split); flash(`A/B запущен: ${split}% на v${v}`); loadVersions(key); loadTemplates(); }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };
  const loadInto = (ver: any) => { setBody(ver.body); setModel(ver.model ?? ''); setNote(''); };

  return (
    <>
      <div className="dim" style={{ fontSize: 12 }}>
        Инструкции ИИ вынесены из кода в версии: правьте, тестируйте и откатывайте без релиза. Ваши правки — копия системного промпта (оригинал не меняется).
      </div>
      {msg && <div className="dim">{msg}</div>}

      <div className="drawer-section-title">Промпт</div>
      <select className="input" value={key ?? ''} onChange={(e) => setKey(e.target.value)}>
        {templates.map((t) => (
          <option key={t.key} value={t.key}>{t.title} {t.customized ? '(изменён)' : ''} · v{t.activeVersion ?? '—'}</option>
        ))}
      </select>

      {data && (
        <>
          <div className="drawer-section-title">Текст (плейсхолдеры {'{{'}переменная{'}}'})</div>
          <textarea className="input" style={{ minHeight: 140, fontFamily: 'inherit', resize: 'vertical' }}
            value={body} onChange={(e) => setBody(e.target.value)} />
          {vars.length > 0 && <div className="dim" style={{ fontSize: 12 }}>Переменные: {vars.map((v) => `{{${v}}}`).join(', ')}</div>}

          <div className="team-rate" style={{ marginTop: 6 }}>
            <input className="input" placeholder="Модель (опц., напр. gpt-4o-mini)" value={model} onChange={(e) => setModel(e.target.value)} />
            <input className="input" placeholder="Что изменено (note)" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} disabled={busy} onClick={saveVersion}>
            Сохранить как новую версию
          </button>

          <div className="drawer-section-title">История версий</div>
          {data.versions.map((v: any) => {
            const m = metrics[v.version];
            return (
              <div key={v.id} className="team-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, padding: '8px 0', borderBottom: '1px solid var(--border, #2a2a2a)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div><b>v{v.version}</b> · {STATUS[v.status] ?? v.status}{v.status === 'testing' && v.abSplit ? ` ${v.abSplit}%` : ''}{v.model ? ` · ${v.model}` : ''}</div>
                  <div style={{ display: 'flex', gap: 6 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => loadInto(v)}>В редактор</button>
                    {v.status !== 'active' && <button className="btn btn-sm" onClick={() => activate(v.version)}>Сделать активной</button>}
                    {v.status !== 'active' && <button className="btn btn-ghost btn-sm" title="Запустить A/B: доля трафика на этот вариант" onClick={() => startAb(v.version)}>A/B</button>}
                    {v.status !== 'active' && <button className="btn btn-ghost btn-sm" onClick={() => deprecate(v.version)}>Снять</button>}
                  </div>
                </div>
                {v.note && <div className="dim" style={{ fontSize: 12 }}>{v.note}</div>}
                {m && (m.calls > 0 || m.up > 0 || m.down > 0) && (
                  <div className="dim" style={{ fontSize: 12 }}>
                    За 30 дней: вызовов {m.calls}, токенов {(m.input_tokens ?? 0) + (m.output_tokens ?? 0)}{m.cache_hits ? `, из кэша ${m.cache_hits}` : ''}
                    {(m.up > 0 || m.down > 0) && (
                      <> · оценки 👍 {m.up} / 👎 {m.down}
                        {(m.up + m.down) > 0 && <> ({Math.round((m.up / (m.up + m.down)) * 100)}% положит.)</>}
                      </>
                    )}
                    {m.reworked > 0 && <> · переделок {m.reworked}</>}
                  </div>
                )}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
