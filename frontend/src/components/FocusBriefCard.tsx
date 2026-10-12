import { useCallback, useEffect, useState } from 'react';
import './focus-brief.css';
import { Icon } from './Icon';
import { Button } from './ui/button';
import { AudioClip } from './meetings/AudioClip';
import { api, ApiError, FocusBrief, FocusBriefEvent, FocusBriefSettings } from '../lib/api';
import { navigate } from '../lib/router';
import { getSocket } from '../lib/socket';

type Ready = Extract<FocusBrief, { status: 'ready' }>;

const STEPS = ['Проверил ваши задачи', 'Посмотрел вчерашние решения', 'Формирую главные действия'];

const REASONS: { id: string; label: string }[] = [
  { id: 'not_relevant', label: 'Неактуально' },
  { id: 'missed_task', label: 'Пропущена важная задача' },
  { id: 'too_detailed', label: 'Слишком много деталей' },
  { id: 'wrong_priority', label: 'Неверный приоритет' },
  { id: 'other', label: 'Другое' },
];

const VOICE_LABEL: Record<string, string> = {
  alloy: 'Нейтральный', nova: 'Мягкий', shimmer: 'Светлый', echo: 'Низкий', onyx: 'Глубокий', fable: 'Выразительный',
};

export const trackBrief = (e: FocusBriefEvent) => { void api.focusBriefEvent(e).catch(() => undefined); };

/**
 * Персональный ИИ-брифинг сверху «Фокуса дня» (ТЗ-27, п. 5–9): 3–5 предложений —
 * что изменилось, что горит, что ждёт решения, что уже подготовлено. Под ним сразу
 * тройка: «прочитал → нажал → работаешь».
 *
 * Что здесь важно не сломать:
 * - Текст, голос и тройка — из одного снимка на сервере; карточка ничего не считает.
 * - Голос не играет сам (п. 33): плеер появляется по нажатию и только тогда играет.
 * - Нет голоса или он сломался — карточка и экран живут текстом (п. 31–32).
 * - Новое важное днём не переписывает брифинг молча: обновляет человек (п. 40).
 */
export default function FocusBriefCard({ initial }: { initial: FocusBrief }) {
  const [brief, setBrief] = useState<FocusBrief>(initial);
  const [step, setStep] = useState(0);
  const [why, setWhy] = useState(false);
  const [player, setPlayer] = useState<{ url: string; sec: number } | null>(null);
  const [audioBusy, setAudioBusy] = useState(false);
  const [audioErr, setAudioErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [asking, setAsking] = useState(false);
  const [settings, setSettings] = useState<FocusBriefSettings | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => { setBrief(initial); }, [initial]);

  const reload = useCallback(async () => {
    try { setBrief(await api.focusBrief()); } catch { /* экран живёт без брифинга */ }
  }, []);

  // сборка идёт — показываем ход и ждём событие; без сокета — переспрашиваем сами
  const generating = brief.enabled && brief.status === 'generating';
  useEffect(() => {
    if (!generating) return;
    setStep(0);
    const t = window.setInterval(() => setStep((s) => Math.min(STEPS.length - 1, s + 1)), 900);
    const poll = window.setInterval(() => void reload(), 4000);
    const stop = window.setTimeout(() => window.clearInterval(poll), 60_000);
    return () => { window.clearInterval(t); window.clearInterval(poll); window.clearTimeout(stop); };
  }, [generating, reload]);

  useEffect(() => {
    const socket = getSocket();
    const on = () => { void reload(); };
    socket.on('focus.brief.generated', on);
    socket.on('focus.brief.updated', on);
    socket.on('focus.brief.audio_ready', on);
    return () => {
      socket.off('focus.brief.generated', on);
      socket.off('focus.brief.updated', on);
      socket.off('focus.brief.audio_ready', on);
    };
  }, [reload]);

  const ready = brief.enabled && brief.status === 'ready' ? (brief as Ready) : null;

  const listen = async () => {
    if (!ready) return;
    setAudioBusy(true); setAudioErr('');
    try {
      const a = await api.focusBriefAudio();
      if (a.status === 'ready' && a.playbackUrl) {
        setPlayer({ url: a.playbackUrl, sec: a.durationSec ?? ready.audio.durationSec ?? 30 });
        trackBrief('audio_played');
      } else {
        await reload();
      }
    } catch (e) {
      setAudioErr(e instanceof ApiError ? e.message : 'Не удалось загрузить аудио');
    } finally {
      setAudioBusy(false);
    }
  };

  const retryAudio = async () => {
    setAudioBusy(true); setAudioErr('');
    try { await api.focusBriefAudioRegenerate(); await reload(); } catch (e) {
      setAudioErr(e instanceof ApiError ? e.message : 'Не получилось');
    } finally { setAudioBusy(false); }
  };

  const refresh = async () => {
    setBusy(true); setErr(''); setPlayer(null);
    try { setBrief(await api.focusBriefRefresh()); } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось обновить брифинг');
    } finally { setBusy(false); }
  };

  const rate = async (value: 1 | -1, reason?: string) => {
    setAsking(false);
    try {
      await api.focusBriefFeedback(value, reason);
      if (ready) setBrief({ ...ready, feedback: value });
    } catch { /* оценка не важнее работы */ }
  };

  const go = (link: string | null, ev: FocusBriefEvent) => {
    if (!link) return;
    trackBrief(ev);
    navigate(link);
  };

  const openSettings = async () => {
    setSettingsOpen((v) => !v);
    if (!settings) setSettings(await api.focusBriefSettings().catch(() => null));
  };
  const save = async (patch: Parameters<typeof api.focusBriefSaveSettings>[0]) => {
    try {
      const next = await api.focusBriefSaveSettings(patch);
      setSettings(next);
      if (patch.enabled === false) setBrief({ enabled: false });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось сохранить');
    }
  };

  if (!brief.enabled) return null;

  const head = (
    <div className="fb-head">
      <span className="fb-title"><Icon name="sparkles" size={14} /> Персональный брифинг</span>
      {ready && (
        <span className="fb-tools">
          <Button variant="ghost" size="icon-sm" aria-label="Обновить брифинг" title="Обновить брифинг" disabled={busy || !ready.canRefresh} onClick={() => void refresh()}>
            <Icon name="refresh" size={14} />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Настройки брифинга" title="Настройки брифинга" aria-expanded={settingsOpen} onClick={() => void openSettings()}>
            <Icon name="settings" size={14} />
          </Button>
        </span>
      )}
    </div>
  );

  if (!ready) {
    return (
      <section className="fb-card fb-loading" aria-label="Персональный брифинг" aria-busy="true">
        {head}
        <div className="fb-text">QEVO собирает главное на сегодня…</div>
        <ul className="fb-steps">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'fb-step-done' : i === step ? 'fb-step-now' : ''}>
              <Icon name={i < step ? 'check' : 'clock'} size={13} /> {s}
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const a = ready.audio;
  return (
    // мягкий акцент: анимация срабатывает один раз, когда класс появился (п. 71)
    <section className="fb-card fb-accent" aria-label="Персональный брифинг">
      {head}
      <p className="fb-text">
        {ready.sentences
          ? ready.sentences.map((s, i) => <span key={i}>{s.text} </span>)
          : ready.text}
      </p>

      {ready.actions.length > 0 && (
        <div className="fb-actions">
          {ready.actions.map((x) => (
            <Button key={x.kind} variant="outline" size="sm" onClick={() => go(x.link, 'action_opened')}>{x.label}</Button>
          ))}
        </div>
      )}

      <div className="fb-row">
        {player ? (
          <AudioClip url={player.url} start={0} end={player.sec} autoPlay onEnded={() => trackBrief('audio_completed')} label="Брифинг" />
        ) : a.status === 'ready' ? (
          <Button variant="secondary" size="sm" disabled={audioBusy} onClick={() => void listen()}><Icon name="play" size={13} /> {a.label}</Button>
        ) : a.status === 'pending' || a.status === 'none' ? (
          <Button variant="secondary" size="sm" disabled><Icon name="volume" size={13} /> Готовим аудио…</Button>
        ) : null}
        {ready.sources.length > 0 && (
          <Button variant="ghost" size="sm" aria-expanded={why} onClick={() => setWhy((v) => !v)}><Icon name="info" size={13} /> Почему это важно?</Button>
        )}
        <span className="fb-rate">
          {ready.feedback == null ? (
            <>
              <Button variant="ghost" size="icon-sm" aria-label="Полезно" title="Полезно" onClick={() => void rate(1)}><Icon name="thumbs-up" size={14} /></Button>
              <Button variant="ghost" size="icon-sm" aria-label="Не то главное" title="Не то главное" aria-expanded={asking} onClick={() => setAsking((v) => !v)}><Icon name="thumbs-down" size={14} /></Button>
            </>
          ) : <span className="dim">Спасибо</span>}
        </span>
      </div>

      {a.status === 'failed' && !player && (
        <div className="fb-note dim" role="status">
          Не удалось подготовить аудио. Текстовый брифинг доступен.{' '}
          {a.canRetry && <button type="button" className="link-btn" disabled={audioBusy} onClick={() => void retryAudio()}>Повторить</button>}
        </div>
      )}
      {audioErr && <div className="fb-note error-text">{audioErr}</div>}
      {err && <div className="fb-note error-text">{err}</div>}

      {asking && (
        <div className="fb-reasons" role="group" aria-label="Что не так?">
          <span className="dim">Что не так?</span>
          {REASONS.map((r) => (
            <button key={r.id} type="button" className="fd-chip" onClick={() => void rate(-1, r.id)}>{r.label}</button>
          ))}
        </div>
      )}

      {why && (
        <ul className="fb-sources" aria-label="Источники">
          {ready.sources.map((s) => (
            <li key={s.id}>
              {s.link
                ? <button type="button" className="link-btn" onClick={() => go(s.link, 'source_opened')}>{s.label}</button>
                : <span>{s.label}</span>}
            </li>
          ))}
        </ul>
      )}

      {settingsOpen && settings && (
        <div className="fb-settings" aria-label="Настройки брифинга">
          <label><input type="checkbox" checked={settings.enabled} onChange={(e) => void save({ enabled: e.target.checked })} /> Персональный брифинг</label>
          <label><input type="checkbox" checked={settings.audio} onChange={(e) => void save({ audio: e.target.checked })} /> Голосовая версия</label>
          <label>
            Голос{' '}
            <select value={settings.voice} onChange={(e) => void save({ voice: e.target.value })}>
              {settings.voices.map((v) => <option key={v} value={v}>{VOICE_LABEL[v] ?? v}</option>)}
            </select>
          </label>
          <label>
            Длина{' '}
            <select value={settings.length} onChange={(e) => void save({ length: e.target.value as 'short' | 'normal' })}>
              <option value="normal">Обычно (3–5 предложений)</option>
              <option value="short">Коротко (2–3)</option>
            </select>
          </label>
          <label>
            Собирать в{' '}
            <input type="time" value={settings.generateAt} onChange={(e) => e.target.value && void save({ generateAt: e.target.value })} />
          </label>
          {settings.boss && (
            <label><input type="checkbox" checked={settings.effective.teamSignals} onChange={(e) => void save({ teamSignals: e.target.checked })} /> Сигналы команды</label>
          )}
          <label><input type="checkbox" checked={settings.effective.clients} onChange={(e) => void save({ clients: e.target.checked })} /> Клиенты</label>
          <span className="dim fb-settings-hint">Изменения — со следующего брифинга или по «Обновить».</span>
        </div>
      )}
    </section>
  );
}
