import { useCallback, useEffect, useRef, useState } from 'react';
import './ai-demo.css';
import { Icon } from '../components/Icon';
import { Button } from '../components/ui/button';
import { api, ApiError, type AiDemoDraft, type AiDemoEntry, type AiDemoView } from '../lib/api';
import { feedback } from '../lib/feedback';
import { navigate } from '../lib/router';
import { getSocket } from '../lib/socket';
import { openSupport } from '../components/support/SupportDock';

/**
 * «Протестировать магию ИИ-созвона за 30 секунд» (ТЗ-24).
 *
 * Не рассказывать, что умеет ИИ, а дать это почувствовать своим голосом: сказал фразу —
 * получил настоящие задачи. Экран выглядит как звонок с QEVO Bot, но звук пишется
 * в браузере и уходит файлом (решение 11.10): настоящая комната созвона ради одного
 * человека — лишний риск сбоя на первой минуте знакомства.
 */
type Phase = 'intro' | 'call' | 'text' | 'processing' | 'review' | 'failed' | 'done';

const EXAMPLES = ['Обновить логотип к среде', 'Созвониться с маркетологом', 'Подготовить коммерческое предложение к пятнице'];
const GREETING = 'Привет! Назовите одну или две рабочие вещи, которые нужно сделать. Например: подготовить презентацию к пятнице и назначить встречу с дизайнером.';
const NUDGE = 'Можете сказать любую простую рабочую задачу.';
const GOT_IT = 'Отлично, я всё понял. Сейчас покажу, как QEVO разложил это по задачам.';
/** Пауза после речи, после которой «звонок» завершается сам (§21). */
const SILENCE_AFTER_SPEECH_MS = 2200;
const NUDGE_AFTER_MS = 6500;

export function AiDemoPage() {
  const entry = useRef<AiDemoEntry>(entryFromUrl());
  const [phase, setPhase] = useState<Phase>('intro');
  const [demo, setDemo] = useState<{ id: string; mode: 'ai' | 'rules'; maxSeconds: number } | null>(null);
  const [view, setView] = useState<AiDemoView | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  // старт демо: заводим попытку сразу, чтобы воронка видела «начал» (§53)
  const ensureDemo = useCallback(async () => {
    if (demo) return demo;
    const d = await api.aiDemoStart(entry.current);
    const next = { id: d.demoId, mode: d.mode, maxSeconds: d.maxSeconds };
    setDemo(next);
    return next;
  }, [demo]);

  const begin = async (how: 'call' | 'text') => {
    setErr(''); setBusy(true);
    try {
      const d = await ensureDemo();
      // в режиме правил голос понимает только браузер; не умеет — сразу текстом
      setPhase(how === 'call' && d.mode === 'rules' && !speechRecognitionCtor() ? 'text' : how);
      feedback('tap');
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не получилось начать демо');
    } finally { setBusy(false); }
  };

  const send = async (input: { audio?: Blob; text?: string }) => {
    if (!demo) return;
    setPhase('processing'); setErr('');
    try { await api.aiDemoFinish(demo.id, input); }
    catch (e) { setErr(e instanceof ApiError ? e.message : 'Не удалось отправить'); setPhase('failed'); }
  };

  // ждём итогов: событие + опрос как подстраховка
  useEffect(() => {
    if (phase !== 'processing' || !demo) return;
    let stop = false;
    const since = Date.now();
    const check = async () => {
      const v = await api.aiDemoGet(demo.id).catch(() => null);
      if (stop) return;
      // итогов нет минуту — не крутим вечно: «Сказать ещё раз» или текстом
      if (Date.now() - since > 60_000 && (!v || v.status === 'processing')) { setPhase('failed'); return; }
      if (!v) return;
      setView(v);
      if (v.status === 'review') { setPhase('review'); feedback('postcall.ready', { el: document.querySelector('.aid-review') }); }
      else if (v.status === 'failed') { setPhase('failed'); feedback('warning'); }
    };
    const socket = getSocket();
    const on = (p: { demoId: string }) => { if (String(p.demoId) === demo.id) void check(); };
    socket.on('onboarding.ai_call', on);
    const timer = window.setInterval(() => void check(), 900);
    return () => { stop = true; socket.off('onboarding.ai_call', on); window.clearInterval(timer); };
  }, [phase, demo]);

  const skip = async () => {
    await api.aiDemoSkip(entry.current).catch(() => undefined);
    close();
  };

  return (
    <div className="aid" role="dialog" aria-label="Демо AI-созвона">
      <div className="aid-shell">
        <button className="aid-close" onClick={() => (phase === 'intro' ? void skip() : close())} aria-label="Закрыть демо" title="Закрыть">
          <Icon name="close" size={18} />
        </button>

        {phase === 'intro' && (
          <section className="aid-intro">
            <div className="aid-spark"><Icon name="sparkles" size={28} /></div>
            <h1>Магия AI-созвона за 30 секунд</h1>
            <p className="aid-lead">Скажите одну рабочую фразу — QEVO сам превратит её в задачи.</p>
            <ul className="aid-points">
              <li><Icon name="check" size={14} /> Без настройки</li>
              <li><Icon name="check" size={14} /> Без команды</li>
              <li><Icon name="check" size={14} /> Без создания проекта вручную</li>
            </ul>
            <p className="dim aid-note">
              Понадобится микрофон: разговор расшифрует QEVO Bot, чтобы показать создание задач. Запись звука не хранится.
            </p>
            {err && <div className="error-text">{err}</div>}
            <div className="aid-actions">
              <Button variant="primary" size="lg" onClick={() => void begin('call')} loading={busy}>
                <Icon name="mic" size={16} /> Начать
              </Button>
              <Button variant="outline" onClick={() => void begin('text')} disabled={busy}>Ввести текстом</Button>
              <Button variant="ghost" onClick={() => void skip()}>Пропустить</Button>
            </div>
          </section>
        )}

        {phase === 'call' && demo && (
          <Call
            mode={demo.mode}
            maxSeconds={demo.maxSeconds}
            onDone={(input) => void send(input)}
            onText={() => setPhase('text')}
          />
        )}

        {phase === 'text' && <TextInput onDone={(text) => void send({ text })} />}

        {phase === 'processing' && <Processing transcript={view?.transcript ?? null} />}

        {phase === 'failed' && (
          <section className="aid-intro">
            <h2>{view?.error === 'stt' || !view?.transcript ? 'Не удалось точно распознать фразу' : 'Не получилось разобрать фразу'}</h2>
            {view?.transcript && <p className="aid-quote">«{view.transcript}»</p>}
            {err && <div className="error-text">{err}</div>}
            <div className="aid-actions">
              <Button variant="primary" onClick={() => { setErr(''); setPhase(demo?.mode === 'rules' && !speechRecognitionCtor() ? 'text' : 'call'); }}>
                <Icon name="mic" size={16} /> Сказать ещё раз
              </Button>
              <Button variant="outline" onClick={() => setPhase('text')}>Ввести текстом</Button>
            </div>
          </section>
        )}

        {phase === 'review' && view && demo && (
          <Review
            view={view}
            onCreated={(v) => { setView(v); setPhase('done'); }}
            onSkip={() => { void api.aiDemoComplete(demo.id).catch(() => undefined); close(); }}
            busy={busy}
            setBusy={setBusy}
          />
        )}

        {phase === 'done' && view && <Done view={view} />}
      </div>
    </div>
  );
}

/** «Звонок» с QEVO Bot: слушает, сам заканчивает после фразы и паузы. */
function Call({ mode, maxSeconds, onDone, onText }: {
  mode: 'ai' | 'rules'; maxSeconds: number;
  onDone: (input: { audio?: Blob; text?: string }) => void; onText: () => void;
}) {
  const [secs, setSecs] = useState(0);
  const [speaking, setSpeaking] = useState(false); // говорит человек
  const [botLine, setBotLine] = useState(GREETING);
  const [heard, setHeard] = useState(''); // распознанное браузером (режим правил)
  const [micErr, setMicErr] = useState('');
  const [muted, setMuted] = useState(false);
  const finished = useRef(false);
  const stopRef = useRef<() => void>(() => undefined);
  const streamRef = useRef<MediaStream | null>(null);
  // колбэк родителя меняется на каждой перерисовке — держим в ссылке, иначе запись перезапускалась бы
  const doneRef = useRef(onDone);
  doneRef.current = onDone;

  useEffect(() => {
    let stream: MediaStream | null = null;
    let rec: MediaRecorder | null = null;
    let recog: { stop(): void; abort(): void } | null = null;
    let ctx: AudioContext | null = null;
    let raf = 0;
    const chunks: Blob[] = [];
    let heardText = '';
    let spokeMs = 0;
    let lastVoice = 0;
    const started = performance.now();
    let nudged = false;

    const finish = () => {
      if (finished.current) return;
      finished.current = true;
      cancelAnimationFrame(raf);
      say(GOT_IT);
      setBotLine(GOT_IT);
      if (mode === 'rules') {
        recog?.stop();
        window.setTimeout(() => { cleanup(); doneRef.current({ text: heardText.trim() }); }, 500);
        return;
      }
      if (rec && rec.state !== 'inactive') rec.stop();
      else { cleanup(); doneRef.current({ text: heardText.trim() || undefined }); }
    };
    stopRef.current = finish;

    const cleanup = () => {
      cancelAnimationFrame(raf);
      try { recog?.abort(); } catch { /* уже остановлен */ }
      stream?.getTracks().forEach((t) => t.stop()); // индикатор микрофона гаснет сразу
      void ctx?.close().catch(() => undefined);
    };

    (async () => {
      say(GREETING);
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch {
        setMicErr('Нет доступа к микрофону');
        return;
      }
      if (finished.current) { stream.getTracks().forEach((t) => t.stop()); return; }
      streamRef.current = stream;
      if (mode === 'ai') {
        const type = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? '';
        rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
        rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        rec.onstop = () => { cleanup(); doneRef.current({ audio: new Blob(chunks, { type: rec?.mimeType || 'audio/webm' }) }); };
        rec.start(500);
      } else {
        const Ctor = speechRecognitionCtor();
        if (!Ctor) { setMicErr('Этот браузер не распознаёт речь'); return; }
        const r = new Ctor();
        r.lang = 'ru-RU'; r.continuous = true; r.interimResults = true;
        r.onresult = (e: any) => {
          let text = '';
          for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
          heardText = text; setHeard(text);
        };
        r.onerror = () => undefined;
        r.start();
        recog = r;
      }
      // «слушает»: громкость микрофона — по ней и пауза после фразы, и подсказка молчащему
      ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const an = ctx.createAnalyser();
      an.fftSize = 1024;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let prev = performance.now();
      const tick = () => {
        const now = performance.now();
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const loud = Math.sqrt(sum / buf.length) > 0.02;
        if (loud) { spokeMs += now - prev; lastVoice = now; }
        setSpeaking(loud);
        prev = now;
        const elapsed = now - started;
        if (!nudged && spokeMs < 300 && elapsed > NUDGE_AFTER_MS) { nudged = true; setBotLine(NUDGE); say(NUDGE); }
        // сказал хоть что-то внятное и замолчал — разговор окончен
        if (spokeMs > 1500 && now - lastVoice > SILENCE_AFTER_SPEECH_MS) return finish();
        if (elapsed > maxSeconds * 1000) return finish();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    })();

    const clock = window.setInterval(() => setSecs((s) => s + 1), 1000);
    return () => {
      window.clearInterval(clock);
      window.speechSynthesis?.cancel();
      // ушли с «звонка» (на текст, закрыли) — запись не отправляем
      if (!finished.current) {
        finished.current = true;
        if (rec) rec.onstop = null;
        try { if (rec && rec.state !== 'inactive') rec.stop(); } catch { /* уже остановлена */ }
        cleanup();
      }
    };
  }, [mode, maxSeconds]);

  // микрофон выключаем у самого потока: «выключил» должно значить «не слышно»
  const toggleMute = () => {
    const next = !muted;
    streamRef.current?.getAudioTracks().forEach((t) => { t.enabled = !next; });
    setMuted(next);
  };

  if (micErr) {
    return (
      <section className="aid-intro">
        <h2>{micErr}</h2>
        <p className="dim">Разрешите микрофон в настройках браузера или телефона — или напишите фразу текстом.</p>
        <div className="aid-actions">
          <Button variant="primary" onClick={onText}>Попробовать текстом</Button>
          <Button variant="outline" onClick={() => window.location.reload()}>Разрешить микрофон</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="aid-call">
      <div className={`aid-bot${speaking ? '' : ' aid-bot-idle'} ai-working`}>
        <Icon name="robot" size={34} />
      </div>
      <div className="aid-who">QEVO Bot <span className="dim">· виртуальный собеседник</span></div>
      <div className="aid-status"><span className={`aid-dot${speaking ? ' on' : ''}`} /> {speaking ? 'слушает вас' : 'слушает'} · {fmt(secs)}</div>
      <p className="aid-bot-line">{botLine}</p>
      {heard && <p className="aid-quote">«{heard}»</p>}
      <div className="aid-examples" aria-label="Примеры фраз">
        {EXAMPLES.map((e) => <span key={e} className="aid-chip">«{e}»</span>)}
      </div>
      <div className="aid-actions aid-call-actions">
        <Button variant={muted ? 'outline' : 'secondary'} size="icon" onClick={toggleMute} aria-label="Микрофон" title="Микрофон">
          <Icon name={muted ? 'mic-off' : 'mic'} size={18} />
        </Button>
        <Button variant="destructive" onClick={() => stopRef.current()}>
          <Icon name="phone-off" size={16} /> Завершить
        </Button>
        <Button variant="ghost" onClick={() => { stopRef.current = () => undefined; onText(); }}>Ввести текстом</Button>
      </div>
    </section>
  );
}

function TextInput({ onDone }: { onDone: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <section className="aid-intro">
      <h2>Напишите одну-две рабочие вещи</h2>
      <textarea
        className="input aid-text" rows={3} value={text} autoFocus maxLength={2000}
        onChange={(e) => setText(e.target.value)}
        placeholder="Например: подготовить презентацию к пятнице и назначить встречу с дизайнером"
        aria-label="Рабочая фраза"
      />
      <div className="aid-examples">
        {EXAMPLES.map((e) => (
          <button key={e} type="button" className="aid-chip aid-chip-btn" onClick={() => setText((t) => (t.trim() ? `${t.trim()} и ${lc(e)}` : e))}>
            «{e}»
          </button>
        ))}
      </div>
      <div className="aid-actions">
        <Button variant="primary" disabled={!text.trim()} onClick={() => onDone(text.trim())}>Показать, что поймёт QEVO</Button>
      </div>
    </section>
  );
}

/** Прогресс по шагам, а не один бесконечный спиннер (§26). */
function Processing({ transcript }: { transcript: string | null }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setStep((s) => Math.min(s + 1, 2)), 1400);
    return () => window.clearInterval(t);
  }, []);
  const steps = ['Сохраняем разговор', 'Понимаем договорённости', 'Готовим задачи'];
  const at = transcript ? Math.max(step, 1) : step;
  return (
    <section className="aid-intro ai-working aid-processing">
      <h2>QEVO разбирает разговор…</h2>
      {transcript && <p className="aid-quote">«{transcript}»</p>}
      <ol className="aid-steps">
        {steps.map((s, i) => (
          <li key={s} className={i < at ? 'done' : i === at ? 'now' : ''}>
            <Icon name={i < at ? 'check' : i === at ? 'refresh' : 'clock'} size={14} /> {s}
          </li>
        ))}
      </ol>
    </section>
  );
}

function Review({ view, onCreated, onSkip, busy, setBusy }: {
  view: AiDemoView; onCreated: (v: AiDemoView) => void; onSkip: () => void; busy: boolean; setBusy: (b: boolean) => void;
}) {
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(view.drafts.map((d) => [d.id, true])));
  const [edits, setEdits] = useState<Record<string, { title?: string; deadline?: string; assignToMe?: boolean }>>({});
  const [err, setErr] = useState('');
  const chosen = view.drafts.filter((d) => picked[d.id] && !d.taskId);

  const create = async () => {
    setBusy(true); setErr('');
    try {
      const r = await api.aiDemoCreate(view.demoId, chosen.map((d) => {
        const e = edits[d.id] ?? {};
        return {
          draftId: d.id,
          ...(e.title !== undefined ? { title: e.title } : {}),
          ...(e.deadline !== undefined ? { deadlineAt: e.deadline ? new Date(`${e.deadline}T18:00:00`).toISOString() : '' } : {}),
          ...(e.assignToMe !== undefined ? { assignToMe: e.assignToMe } : {}),
        };
      }));
      if (r.failed.length && !r.created.length) { setErr('Задачи не создались — можно повторить, ничего не потеряно'); feedback('error'); return; }
      feedback('task.created', { count: r.created.length });
      onCreated(await api.aiDemoGet(view.demoId));
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Не удалось создать задачи — можно повторить');
    } finally { setBusy(false); }
  };

  const word = (n: number) => (n === 1 ? 'задачу' : n < 5 ? 'задачи' : 'задач');
  return (
    <section className="aid-review">
      <h2><Icon name="sparkles" size={18} /> Вот что QEVO понял из вашего разговора</h2>
      {view.transcript && (
        <div className="aid-block">
          <div className="aid-label">Вы сказали</div>
          <p className="aid-quote">«{view.transcript}»</p>
        </div>
      )}
      {view.summary && (
        <div className="aid-block">
          <div className="aid-label">Кратко</div>
          <p>{view.summary}</p>
        </div>
      )}
      <div className="aid-block">
        <div className="aid-label">Задачи — {view.drafts.length}</div>
        {view.drafts.map((d) => (
          <DraftLine
            key={d.id} draft={d} picked={!!picked[d.id]} onPick={(v) => setPicked((p) => ({ ...p, [d.id]: v }))}
            edit={edits[d.id] ?? {}} onEdit={(e) => setEdits((m) => ({ ...m, [d.id]: { ...m[d.id], ...e } }))}
          />
        ))}
      </div>
      {err && <div className="error-text">{err}</div>}
      <div className="aid-actions">
        <Button variant="primary" size="lg" onClick={() => void create()} loading={busy} disabled={!chosen.length}>
          Создать {chosen.length} {word(chosen.length)}
        </Button>
        <Button variant="ghost" onClick={onSkip}>Не создавать, продолжить знакомство</Button>
      </div>
    </section>
  );
}

function DraftLine({ draft, picked, onPick, edit, onEdit }: {
  draft: AiDemoDraft; picked: boolean; onPick: (v: boolean) => void;
  edit: { title?: string; deadline?: string; assignToMe?: boolean }; onEdit: (e: { title?: string; deadline?: string; assignToMe?: boolean }) => void;
}) {
  const deadline = edit.deadline ?? (draft.deadlineAt ? new Date(draft.deadlineAt).toLocaleDateString('sv-SE') : '');
  const toMe = edit.assignToMe ?? (draft.assigneeId ? true : undefined);
  return (
    <div className={`aid-draft${picked ? '' : ' off'}`}>
      <input type="checkbox" checked={picked} onChange={(e) => onPick(e.target.checked)} aria-label={`Создать «${draft.title}»`} />
      <div className="aid-draft-main">
        <input
          className="aid-draft-title" value={edit.title ?? draft.title} maxLength={255}
          onChange={(e) => onEdit({ title: e.target.value })} aria-label="Название задачи"
        />
        <div className="aid-draft-meta">
          {draft.kind === 'meeting' && <span className="ui-badge ui-badge-info">встреча</span>}
          <label>Срок <input type="date" className="input aid-date" value={deadline} onChange={(e) => onEdit({ deadline: e.target.value })} /></label>
          {draft.assigneeHint && toMe === undefined ? (
            <span className="aid-unsure">
              Исполнитель: {draft.assigneeHint} — сотрудник не найден{' '}
              <button type="button" className="link-btn" onClick={() => onEdit({ assignToMe: true })}>Назначить себе</button>{' · '}
              <button type="button" className="link-btn" onClick={() => onEdit({ assignToMe: false })}>Без исполнителя</button>
            </span>
          ) : (
            <span className="dim">Исполнитель: {toMe === false ? 'не назначен' : 'вы'}</span>
          )}
        </div>
      </div>
    </div>
  );
}

/** «Готово. Вы только что…» и два следующих шага (§31–32). */
function Done({ view }: { view: AiDemoView }) {
  const [converted, setConverted] = useState(false);
  useEffect(() => {
    void api.aiDemoComplete(view.demoId).catch(() => undefined);
    feedback('milestone', { el: document.querySelector('.aid-done') });
  }, [view.demoId]);
  const n = view.createdTaskCount;
  return (
    <section className="aid-intro aid-done">
      <div className="aid-spark"><Icon name="check" size={28} /></div>
      <h1>Готово</h1>
      <p className="aid-lead">QEVO создал ваш первый рабочий план</p>
      <ul className="aid-points">
        <li><Icon name="check" size={14} /> поговорили с QEVO Bot</li>
        <li><Icon name="check" size={14} /> получили автоматический протокол</li>
        <li><Icon name="check" size={14} /> создали {n} {n === 1 ? 'задачу' : n < 5 ? 'задачи' : 'задач'} {view.input === 'text' ? 'одной фразой' : 'голосом'}</li>
      </ul>
      <p className="dim aid-note">Я могу делать то же самое после каждого вашего рабочего созвона — включите ИИ в звонке.</p>
      <div className="aid-actions">
        {view.projectId && (
          <Button variant="primary" size="lg" onClick={() => navigate({ section: 'projects', projectId: view.projectId! })}>
            Открыть доску
          </Button>
        )}
        {view.projectId && !converted && (
          <Button variant="outline" onClick={() => void api.aiDemoConvert(view.projectId!).then(() => setConverted(true)).catch(() => undefined)}>
            Сделать проект рабочим
          </Button>
        )}
      </div>
      <div className="aid-next">
        <span className="dim">Дальше:</span>
        <button type="button" className="link-btn" onClick={() => navigate({ section: 'projects' })}>Создать настоящий проект</button>
        <button type="button" className="link-btn" onClick={() => navigate({ section: 'settings', tab: 'team' })}>Пригласить команду</button>
      </div>
      {/* ТЗ-29 (п. 51): нужна помощь с настройкой — живой инженер, прямо здесь */}
      <p className="dim aid-note">
        Нужна помощь с настройкой? Живой инженер QEVO может подключиться прямо здесь.{' '}
        <button type="button" className="link-btn" onClick={() => openSupport()}>Позвать инженера</button>
      </p>
    </section>
  );
}

function close() {
  window.speechSynthesis?.cancel();
  navigate({ section: 'focus' }, { replace: true });
}

/** Голос QEVO Bot — голосом браузера (решение 11.10): бесплатно, есть русский. Нет — только текст. */
function say(text: string) {
  try {
    const synth = window.speechSynthesis;
    if (!synth) return;
    synth.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ru-RU';
    u.rate = 1.05;
    const ru = synth.getVoices().find((v) => v.lang?.toLowerCase().startsWith('ru'));
    if (ru) u.voice = ru;
    synth.speak(u);
  } catch { /* без голоса — текст на экране остаётся */ }
}

function speechRecognitionCtor(): (new () => any) | null {
  const w = window as unknown as { SpeechRecognition?: new () => any; webkitSpeechRecognition?: new () => any };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function entryFromUrl(): AiDemoEntry {
  const v = new URLSearchParams(window.location.search).get('from');
  return v === 'checklist' || v === 'projects_empty' || v === 'meetings_empty' ? v : 'welcome';
}

const fmt = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
const lc = (s: string) => s.charAt(0).toLowerCase() + s.slice(1);
