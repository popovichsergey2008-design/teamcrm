import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import { OptionSelect } from './ui/option-select';

/** Подписи моделей Kimi в выборе: чем они отличаются для работы CRM. */
const KIMI_HINT: Record<string, string> = {
  'kimi-k3': 'флагман, рассуждает (медленнее, дороже)',
  'kimi-k2.6': 'быстрая, без рассуждений',
  'kimi-k2.7-code': 'для кода',
  'kimi-k2.7-code-highspeed': 'для кода, быстрая',
};

/** BYOK: ключи ИИ-провайдеров (шифруются на сервере) + выбор модели чата. Встраивается в «Интеграции». */
export function AiSettingsSection() {
  const [s, setS] = useState<any>(null);
  const [openaiKey, setOpenaiKey] = useState('');
  const [anthropicKey, setAnthropicKey] = useState('');
  const [openrouterKey, setOpenrouterKey] = useState('');
  const [kimiKey, setKimiKey] = useState('');
  const [brainModel, setBrainModel] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [msg, setMsg] = useState('');
  /** Результат пробного вызова: отвечает ли выбранная модель и кто ответил на самом деле. */
  const [check, setCheck] = useState<{ ok: boolean; answered: string | null; fallback: boolean; error: string | null } | null>(null);
  const [checking, setChecking] = useState(false);
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500); };

  const load = () => api.aiSettingsGet().then((r) => { setS(r); setBrainModel(r.brainModel ?? ''); }).catch(() => undefined);
  const loadModels = () => api.aiSettingsModels().then(setModels).catch(() => undefined);
  useEffect(() => { load(); loadModels(); }, []);

  const save = async (patch: { openaiKey?: string; anthropicKey?: string; openrouterKey?: string; kimiKey?: string; brainModel?: string }) => {
    try { const r = await api.aiSettingsSave(patch); setS(r); setBrainModel(r.brainModel ?? ''); flash('Сохранено'); loadModels(); return r; }
    catch (e) { flash(e instanceof ApiError ? e.message : 'Ошибка'); }
  };

  const saveKeys = async () => {
    const patch: any = {};
    if (openaiKey.trim()) patch.openaiKey = openaiKey.trim();
    if (anthropicKey.trim()) patch.anthropicKey = anthropicKey.trim();
    if (openrouterKey.trim()) patch.openrouterKey = openrouterKey.trim();
    if (kimiKey.trim()) patch.kimiKey = kimiKey.trim();
    if (!Object.keys(patch).length) return flash('Вставьте ключ');
    await save(patch);
    setOpenaiKey(''); setAnthropicKey(''); setOpenrouterKey(''); setKimiKey('');
  };

  if (!s) return null;
  return (
    <>
        <div className="dim" style={{ fontSize: 12 }}>Ваш ключ шифруется на сервере и используется вместо общего. Нужен для реального семантического поиска и ответов ИИ.</div>
        {/* #4624: пробный ИИ общим ключом — пока своего ключа нет */}
        {s.trial?.serverKey && s.trial.reason !== 'platform' && (
          <div className={s.trial.allowed ? 'pnl-good' : 'error-text'} style={{ fontSize: 12, margin: '6px 0' }}>
            {s.trial.allowed
              ? `Пробный ИИ: использовано ${Math.round(s.trial.tokensUsed / 1000)} тыс. из ${Math.round(s.trial.tokensLimit / 1000)} тыс. токенов, до ${new Date(s.trial.endsAt).toLocaleDateString('ru-RU')}. Потом — свой ключ ниже.`
              : s.trial.reason === 'exhausted'
                ? 'Пробные токены ИИ закончились. Чтобы ИИ работал дальше, укажите свой ключ ниже.'
                : 'Пробный период ИИ закончился. Чтобы ИИ работал дальше, укажите свой ключ ниже.'}
          </div>
        )}
        {msg && <div className="dim">{msg}</div>}

        {/* Kimi — основной ИИ (19.10): с его ключом вся текстовая работа ИИ идёт через Kimi */}
        <div className="drawer-section-title">Ключ Kimi (Moonshot AI) — основной ИИ</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
          Статус: {s.kimiKeySet ? 'задан (свой)' : s.globalKimi && s.trial?.allowed !== false ? 'используется общий' : '— не задан —'}.
          {' '}С ключом Kimi через него идёт вся текстовая работа ИИ: QEVO Bot, разбор встреч и чатов, черновики задач,
          сводки, секретарь. Расшифровки речи, озвучки и поиска по базе знаний у Kimi нет — для них остаётся ключ OpenAI.
          Ключ — на <span className="dim">platform.kimi.ai</span>.
        </div>
        <input className="input add-user-input" type="password" placeholder="sk-... (ключ Kimi)" value={kimiKey} onChange={(e) => setKimiKey(e.target.value)} />

        <div className="drawer-section-title">Ключ OpenAI (GPT) — речь, голос, поиск</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
          Статус: {s.openaiKeySet ? 'задан (свой)' : s.globalOpenai ? 'используется общий' : '— не задан —'}
        </div>
        <input className="input add-user-input" type="password" placeholder="sk-... (вставьте, чтобы задать/сменить)" value={openaiKey} onChange={(e) => setOpenaiKey(e.target.value)} />

        <div className="drawer-section-title">Ключ Anthropic (Claude) — опционально</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>Статус: {s.anthropicKeySet ? 'задан' : '— не задан —'}</div>
        <input className="input add-user-input" type="password" placeholder="sk-ant-..." value={anthropicKey} onChange={(e) => setAnthropicKey(e.target.value)} />

        <div className="drawer-section-title">Ключ OpenRouter — опционально (бесплатные модели)</div>
        <div className="dim" style={{ fontSize: 12, marginBottom: 4 }}>
          Статус: {s.openrouterKeySet ? 'задан' : s.globalOpenrouter ? 'используется общий' : '— не задан —'}. Один ключ OpenRouter <b>полностью заменяет OpenAI</b> — покрывает и ответы ИИ (в т.ч. бесплатные модели Llama/DeepSeek/Gemini Flash), и семантический поиск/индексацию (эмбеддинги через OpenRouter). Ключ — на <span className="dim">openrouter.ai/keys</span>.
        </div>
        <input className="input add-user-input" type="password" placeholder="sk-or-..." value={openrouterKey} onChange={(e) => setOpenrouterKey(e.target.value)} />

        <button className="ui-btn ui-btn-primary ui-btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={saveKeys}>Сохранить ключи</button>
        {(s.openaiKeySet || s.anthropicKeySet || s.openrouterKeySet || s.kimiKeySet) && (
          <button className="ui-btn ui-btn-ghost ui-btn-sm" style={{ width: '100%', marginTop: 6 }} onClick={() => save({ openaiKey: '', anthropicKey: '', openrouterKey: '', kimiKey: '' })}>Удалить свои ключи (вернуться к общему)</button>
        )}

        <div className="drawer-section-title">Модель ответов ИИ (Brain)</div>
        <div className="team-rate">
          <OptionSelect className="input" value={brainModel} onChange={(e) => setBrainModel(e.target.value)}>
            <option value="">по умолчанию</option>
            {models.map((m) => <option key={m} value={m}>{m}{m.endsWith(':free') ? ' — бесплатно' : ''}{KIMI_HINT[m] ? ` — ${KIMI_HINT[m]}` : ''}</option>)}
          </OptionSelect>
          <button className="ui-btn ui-btn-outline ui-btn-sm" onClick={() => save({ brainModel })}>Применить</button>
        </div>

        {/* «Есть в списке» и «отвечает» — разные вещи: часть моделей живёт в другом API
            или недоступна аккаунту. Раньше это выяснялось молча — запрос падал,
            включался запасной вариант, и человек считал, что работает выбранная. */}
        <button
          className="ui-btn ui-btn-ghost ui-btn-sm"
          style={{ marginTop: 6 }}
          disabled={checking}
          onClick={async () => {
            setChecking(true); setCheck(null);
            try { setCheck(await api.aiCheckModel()); }
            catch (e) { flash(e instanceof ApiError ? e.message : 'Не удалось проверить'); }
            finally { setChecking(false); }
          }}
        >
          {checking ? 'Проверяю…' : 'Проверить модель'}
        </button>

        {check && (
          <div className={check.ok && !check.fallback ? 'pnl-good' : 'error-text'} style={{ fontSize: 12, marginTop: 6 }}>
            {check.ok && !check.fallback && `Модель ${check.answered} отвечает.`}
            {check.ok && check.fallback && (
              `Выбранная модель не ответила — вместо неё сработала ${check.answered}. `
              + 'Проверьте название и доступ к ней в вашем аккаунте.'
            )}
            {!check.ok && (check.error ?? 'Модель не ответила.')}
          </div>
        )}
        <div className="dim" style={{ fontSize: 12, marginTop: 4 }}>
          Модели по вашим ключам (обновляется после сохранения ключа). Модели с «:free» — бесплатные через OpenRouter.
          Это модель для ответов/чата; эмбеддинги поиска идут через OpenAI-совместимую модель (по вашему ключу OpenAI или OpenRouter).
        </div>
    </>
  );
}
