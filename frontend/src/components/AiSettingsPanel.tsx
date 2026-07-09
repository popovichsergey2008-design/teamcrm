import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';

/** BYOK: ключи ИИ-провайдеров (шифруются на сервере) + выбор модели чата. Встраивается в «Интеграции». */
export function AiSettingsSection() {
  const [s, setS] = useState<any>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [brainModel, setBrainModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };

  const load = () => api.aiSettingsGet().then((r) => { setS(r); setBrainModel(r.brainModel ?? ''); }).catch(() => undefined);
  const loadModels = () => api.aiSettingsModels().then(setModels).catch(() => undefined);
  useEffect(() => { load(); loadModels(); }, []);

  const save = async (patch: { openaiKey?: string; anthropicKey?: string; brainModel?: string }) => {
    try { const r = await api.aiSettingsSave(patch); setS(r); flash('Сохранено'); loadModels(); return r; }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const saveKeys = async () => {
    const patch: any = {};
    if (openaiKey.trim()) patch.openaiKey = openaiKey.trim();
    if (anthropicKey.trim()) patch.anthropicKey = anthropicKey.trim();
    if (!Object.keys(patch).length) return flash('Вставьте ключ');
    await save(patch);
    setOpenaiKey(''); setAnthropicKey('');
  };

  if (!s) return null;
  return (
    <>
        <div className="dim" style={{ fontSize: 12 }}>Ваш ключ шифруется на сервере и используется вместо общего. Нужен для реального семантического поиска и ответов ИИ.</div>
        {msg && <div className="dim">{msg}</div>}

        <div className="drawer-section-title">Ключ OpenAI (GPT)</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
          Статус: {s.openaiKeySet ? '✅ задан (свой)' : s.globalOpenai ? 'используется общий' : '— не задан —'}
        </div>
        <input className="input add-user-input" type="password" placeholder="sk-... (вставьте, чтобы задать/сменить)" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />

        <div className="drawer-section-title">Ключ Anthropic (Claude) — опционально</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Статус: {s.anthropicKeySet ? '✅ задан' : '— не задан —'}</div>
        <input className="input add-user-input" type="password" placeholder="sk-ant-..." value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />

        <button className="btn btn-primary btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={saveKeys}>Сохранить ключи</button>
        {(s.openaiKeySet || s.anthropicKeySet) && (
          <button className="btn btn-ghost btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={() => save({ openaiKey: '', anthropicKey: '' })}>Удалить свои ключи (вернуться к общему)</button>
        )}

        <div className="drawer-section-title">Модель ответов ИИ (Brain)</div>
        <div className="team-rate">
          <select className="input" value={brainModel} onChange={(e) => setBrainModel(e.target.value)}>
            <option value="">по умолчанию</option>
            {models.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
          <button className="btn btn-sm" onClick={() => save({ brainModel })}>Применить</button>
        </div>
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>Список моделей — доступные по вашему ключу OpenAI (обновляется после сохранения ключа).</div>
    </>
  );
}
