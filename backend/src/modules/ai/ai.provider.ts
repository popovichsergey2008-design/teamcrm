import { createHash } from 'crypto';
import { Logger } from '@nestjs/common';

const providerLog = new Logger('AiProvider');

/**
 * Провайдеры AI. Реальные Whisper/Anthropic используются при наличии ключей в env,
 * иначе — детерминированный mock (конвейер полностью работает и тестируется без секретов).
 * Парсер mock'а понимает мини-DSL: "#<id> done 120m", "#<id> progress blocker: ...".
 */
/** Точечные переопределения из версии промпта (PromptOps): модель/лимит токенов под конкретный промпт. */
export interface GenerateOpts {
  model?: string;
  maxTokens?: number;
}

/** Реплика стенограммы: время от начала записи + текст. */
export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface AiProvider {
  name: string;
  transcribe(audioRefOrText: string): Promise<string>;
  /** Транскрипция загруженного аудио-буфера (веб-запись голоса) → текст. '' если реальный Whisper недоступен. */
  transcribeAudio(audio: Buffer, filename: string): Promise<string>;
  /**
   * Транскрипция С ТАЙМКОДАМИ (стенограмма встречи). Куски длинной записи нарезает
   * вызывающий: у Whisper лимит 25 МБ на запрос. [] — распознавание недоступно.
   */
  /** hint — словарь встречи (имена, рабочие слова): заметно снижает число ошибок распознавания. */
  transcribeSegments(audio: Buffer, filename: string, hint?: string): Promise<TranscriptSegment[]>;
  /** schemaHint — версионируемая инструкция парсера (PromptOps); при отсутствии берётся встроенный дефолт. */
  parseIntents(maskedText: string, schemaHint?: string): Promise<unknown>;
  embed(text: string): Promise<number[]>;
  /** Аналитическая генерация (AI Brain): system + user → текст ответа. */
  generate(system: string, user: string, opts?: GenerateOpts): Promise<string>;
  /** Потоковая генерация: onDelta вызывается по мере поступления фрагментов; возвращает полный текст. */
  generateStream(system: string, user: string, opts: GenerateOpts | undefined, onDelta: (text: string) => void): Promise<string>;
}

export const EMBED_DIM = 1536;

/** Детерминированный псевдо-эмбеддинг (1536, единичной длины) — для dev/CI без ключей. */
export function mockEmbed(text: string): number[] {
  const seed = createHash('sha256').update(text).digest();
  // xorshift128, засеянный первыми байтами хеша
  let a = seed.readUInt32LE(0) || 1, b = seed.readUInt32LE(4) || 2, c = seed.readUInt32LE(8) || 3, d = seed.readUInt32LE(12) || 4;
  const rnd = () => {
    const t = a ^ (a << 11);
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return d / 0xffffffff;
  };
  const v = new Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) { const x = rnd() * 2 - 1; v[i] = x; norm += x * x; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) v[i] /= norm;
  return v;
}

function parseMockDsl(text: string): unknown {
  const actions: any[] = [];
  const segments = text.split(/[;\n]+/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const idMatch = seg.match(/#(\d+)/);
    if (!idMatch) continue;
    const action: any = { task_id: idMatch[1] };
    const low = seg.toLowerCase();

    if (/\b(done|готов|сделал|закрыл|завершил)\b/.test(low)) action.status_change = 'DONE';
    else if (/\b(progress|в работе|делаю|начал|приступил)\b/.test(low)) action.status_change = 'IN_PROGRESS';
    else if (/\b(todo|вернул|отложил)\b/.test(low)) action.status_change = 'TODO';

    const t = low.match(/(\d+)\s*(m|min|мин|минут[аы]?|h|ч|час[аов]*)/);
    if (t) {
      const n = Number(t[1]);
      action.time_logged_minutes = /^(h|ч|час)/.test(t[2]) ? n * 60 : n;
    }
    const bl = seg.match(/(?:blocker|блокер|заблок\w*)\s*[:\-—]?\s*(.+)$/i);
    if (bl) action.blocker_detected = bl[1].trim();

    actions.push(action);
  }
  return { actions, confidence: actions.length ? 0.92 : 0 };
}

/**
 * Детерминированный разбор стенограммы без LLM: реплика вида «Имя: беру/сделаю…»
 * считается договорённостью и превращается в задачу. Формат ответа — тот же JSON,
 * что вернула бы модель, поэтому вся цепочка валидации работает как на проде.
 */
function mockMeetingAnalysis(transcript: string): string {
  const lines = transcript.split('\n').filter(Boolean);
  const tasks = lines
    .map((l) => /^\[[\d:]+\]\s*([^:]{2,40}):\s*(.*(?:беру|сделаю|подготовлю|займусь).*)$/i.exec(l))
    .filter((m): m is RegExpExecArray => !!m)
    .slice(0, 5)
    .map((m) => ({
      title: m[2].trim().slice(0, 120),
      description: null,
      assignee: m[1].trim(),
      deadline: null,
      quote: m[0].replace(/^\[[\d:]+\]\s*/, ''),
    }));
  return JSON.stringify({
    summary: `Разобрано реплик: ${lines.length}. (Демо-разбор: подключите ключ ИИ для осмысленной сводки.)`,
    decisions: [],
    risks: [],
    tasks,
  });
}

export class MockAiProvider implements AiProvider {
  name = 'mock';
  async transcribe(audioRefOrText: string): Promise<string> {
    // текстовый дейлик: ref в формате "text:<содержимое>" → транскрипт = содержимое
    if (audioRefOrText.startsWith('text:')) return audioRefOrText.slice(5);
    // голос без реального Whisper — канонический заглушечный транскрипт
    return audioRefOrText;
  }
  async transcribeAudio(_audio: Buffer, _filename: string): Promise<string> {
    void _audio; void _filename; // без ключа OpenAI распознать запись нельзя — пусто (UI подскажет)
    return '';
  }
  async transcribeSegments(_audio: Buffer, _filename: string): Promise<TranscriptSegment[]> {
    void _audio; void _filename;
    return [];
  }
  async parseIntents(maskedText: string, _schemaHint?: string): Promise<unknown> {
    void _schemaHint; // mock понимает мини-DSL и не нуждается в инструкции
    return parseMockDsl(maskedText);
  }
  async embed(text: string): Promise<number[]> {
    return mockEmbed(text);
  }
  async generate(_system: string, user: string, _opts?: GenerateOpts): Promise<string> {
    void _opts;
    // Разбор встречи: без LLM собираем ответ по схеме прямо из стенограммы —
    // берём реплики с явной договорённостью. Это делает путь «встреча → задача»
    // проверяемым на CI, где ключей ИИ нет.
    if (/стенограмму рабочей встречи/.test(_system)) return mockMeetingAnalysis(user);
    const hasCtx = /\[\d+\]/.test(user);
    return hasCtx
      ? 'На основе найденных материалов из архива компании (см. источники ниже). [1]\n\n(Демо-ответ: подключите OPENAI_API_KEY или ANTHROPIC_API_KEY для реальной генерации.)'
      : 'В базе знаний не нашлось релевантных материалов по этому вопросу.';
  }
  async generateStream(system: string, user: string, opts: GenerateOpts | undefined, onDelta: (t: string) => void): Promise<string> {
    // mock: без LLM реального стрима нет — эмулируем «печать», отдавая ответ по словам
    const full = await this.generate(system, user, opts);
    for (const part of full.split(/(\s+)/)) if (part) onDelta(part);
    return full;
  }
}

/** Реальный провайдер (OpenAI Whisper + Anthropic) — активен только при наличии ключей. */
export class RealAiProvider implements AiProvider {
  name = 'real';
  constructor(
    private readonly openaiKey: string | undefined,
    private readonly anthropicKey: string | undefined,
    private readonly model: string,
    private readonly brainModel?: string,
    private readonly openrouterKey?: string,
  ) {}

  /** Вызов OpenAI-совместимого chat/completions (OpenAI и OpenRouter — один формат). Бросает ошибку API. */
  private async chatCompletion(
    url: string, key: string, model: string, system: string, user: string, maxTokens: number, extraHeaders: Record<string, string> = {},
  ): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({
        model, max_tokens: maxTokens,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json?.error) throw new Error(typeof json.error === 'string' ? json.error : (json.error.message || JSON.stringify(json.error)));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json?.choices?.[0]?.message?.content ?? '';
  }

  private async anthropicChat(model: string, system: string, user: string, maxTokens: number): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.anthropicKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json?.error) throw new Error(json.error?.message || JSON.stringify(json.error));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return json?.content?.[0]?.text ?? '';
  }

  async transcribe(audioRefOrText: string): Promise<string> {
    if (audioRefOrText.startsWith('text:')) return audioRefOrText.slice(5);
    if (!this.openaiKey) return audioRefOrText;
    // audioRefOrText — URL временного аудио (Telegram file). Скачиваем и шлём в Whisper.
    const audio = await fetch(audioRefOrText).then((r) => r.arrayBuffer());
    return this.whisper(Buffer.from(audio), 'audio.ogg');
  }

  async transcribeAudio(audio: Buffer, filename: string): Promise<string> {
    if (!this.openaiKey) return '';
    return this.whisper(audio, filename || 'audio.webm');
  }

  async transcribeSegments(audio: Buffer, filename: string, hint?: string): Promise<TranscriptSegment[]> {
    if (!this.openaiKey) return [];
    const json = await this.whisperRaw(audio, filename || 'audio.mp3', 'verbose_json', hint);
    const segments = Array.isArray(json?.segments) ? json.segments : [];
    return segments
      .map((s: any) => ({ start: Number(s.start) || 0, end: Number(s.end) || 0, text: String(s.text ?? '').trim() }))
      .filter((s: TranscriptSegment) => s.text.length > 0);
  }

  /** OpenAI Whisper: аудио-буфер → распознанный текст. */
  private async whisper(audio: Buffer, filename: string): Promise<string> {
    const json = await this.whisperRaw(audio, filename, 'json');
    return json?.text ?? '';
  }

  /**
   * Общий вызов Whisper. verbose_json даёт сегменты с таймкодами — основа стенограммы.
   *
   * Язык указываем явно: на коротких и шумных записях определение языка ошибается,
   * и русская речь распознаётся как похожая на слух латиница.
   *
   * hint — словарь встречи: имена участников и рабочие слова. Whisper принимает его
   * как контекст и заметно реже коверкает то, чего не ожидает: «на Юру» вместо
   * «на евро», «стенограмма» вместо «синаграмма».
   */
  private async whisperRaw(audio: Buffer, filename: string, format: 'json' | 'verbose_json', hint?: string): Promise<any> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(audio)]), filename);
    form.append('model', 'whisper-1');
    form.append('response_format', format);
    form.append('language', 'ru');
    if (hint) form.append('prompt', hint.slice(0, 880)); // Whisper читает не больше ~224 токенов
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiKey!}` },
      body: form,
      signal: AbortSignal.timeout(300_000), // час записи режется на куски, но каждый кусок — минуты
    });
    if (!res.ok) throw new Error(`Whisper HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    return res.json();
  }

  async parseIntents(maskedText: string, schemaHint?: string): Promise<unknown> {
    if (!this.anthropicKey) return new MockAiProvider().parseIntents(maskedText, schemaHint);
    const hint = schemaHint ??
      'Верни СТРОГО JSON {"actions":[{"task_id":number,"status_change":"DONE|IN_PROGRESS|TODO",' +
      '"time_logged_minutes":number,"blocker_detected":string}],"confidence":0..1}. ' +
      'Только JSON, без пояснений.';
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        max_tokens: 1024,
        system: hint,
        messages: [{ role: 'user', content: maskedText }],
      }),
    });
    const json: any = await res.json();
    const text = json?.content?.[0]?.text ?? '{}';
    try {
      return JSON.parse(text.replace(/^```json\s*|\s*```$/g, ''));
    } catch {
      return { actions: [], confidence: 0 };
    }
  }

  async generate(system: string, user: string, opts?: GenerateOpts): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 1500;
    const model = opts?.model || this.brainModel || '';
    const isOpenRouter = model.includes('/'); // id вида vendor/model[:free] → OpenRouter
    const OR_URL = 'https://openrouter.ai/api/v1/chat/completions';
    const ORH = { 'HTTP-Referer': 'https://teamsmrt.com', 'X-Title': 'TeamCRM' };
    const OPENAI_URL = 'https://api.openai.com/v1/chat/completions';

    // Упорядоченные попытки: сначала выбранная модель/провайдер, затем ЛЮБОЙ рабочий бэкенд (чтобы
    // из-за неудачной free-модели не сваливаться в mock, когда есть рабочий ключ).
    const attempts: { name: string; run: () => Promise<string> }[] = [];
    if (isOpenRouter && this.openrouterKey) attempts.push({ name: `openrouter(${model})`, run: () => this.chatCompletion(OR_URL, this.openrouterKey!, model, system, user, maxTokens, ORH) });
    if (this.anthropicKey && (!model || /^claude/i.test(model))) attempts.push({ name: `anthropic(${model || 'default'})`, run: () => this.anthropicChat(model || 'claude-3-5-sonnet-latest', system, user, maxTokens) });
    if (this.openaiKey && !isOpenRouter) attempts.push({ name: `openai(${model || 'gpt-4o-mini'})`, run: () => this.chatCompletion(OPENAI_URL, this.openaiKey!, model || 'gpt-4o-mini', system, user, maxTokens) });
    // фолбэки на любой доступный ключ
    if (this.openaiKey) attempts.push({ name: 'openai(fallback)', run: () => this.chatCompletion(OPENAI_URL, this.openaiKey!, 'gpt-4o-mini', system, user, maxTokens) });
    if (this.anthropicKey) attempts.push({ name: 'anthropic(fallback)', run: () => this.anthropicChat('claude-3-5-sonnet-latest', system, user, maxTokens) });
    if (this.openrouterKey) attempts.push({ name: 'openrouter(fallback)', run: () => this.chatCompletion(OR_URL, this.openrouterKey!, isOpenRouter ? model : 'meta-llama/llama-3.3-70b-instruct:free', system, user, maxTokens, ORH) });

    for (const a of attempts) {
      try {
        const t = await a.run();
        if (t && t.trim()) return t;
        providerLog.warn(`generate: ${a.name} — пустой ответ`);
      } catch (e) {
        providerLog.warn(`generate: ${a.name} — ошибка: ${(e as Error).message}`);
      }
    }
    return new MockAiProvider().generate(system, user, opts);
  }

  /** Читает SSE-поток fetch-ответа, вызывая onData для каждого data-события (JSON). */
  private async readSSE(res: Response, onData: (obj: any) => void): Promise<void> {
    const reader = (res.body as ReadableStream<Uint8Array> | null)?.getReader();
    if (!reader) throw new Error('нет тела потока');
    const decoder = new TextDecoder();
    let buf = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        try { onData(JSON.parse(payload)); } catch { /* keep-alive / частичная строка — пропускаем */ }
      }
    }
  }

  /** Потоковый chat/completions (OpenAI/OpenRouter). */
  private async openaiStream(url: string, key: string, model: string, system: string, user: string, maxTokens: number, onDelta: (t: string) => void, extraHeaders: Record<string, string> = {}): Promise<string> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model, max_tokens: maxTokens, stream: true, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let full = '';
    await this.readSSE(res, (o) => { const d = o?.choices?.[0]?.delta?.content; if (d) { full += d; onDelta(d); } });
    return full;
  }

  /** Потоковый Anthropic messages. */
  private async anthropicStream(model: string, system: string, user: string, maxTokens: number, onDelta: (t: string) => void): Promise<string> {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': this.anthropicKey!, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, stream: true, messages: [{ role: 'user', content: user }] }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    let full = '';
    await this.readSSE(res, (o) => { if (o?.type === 'content_block_delta' && o?.delta?.text) { full += o.delta.text; onDelta(o.delta.text); } });
    return full;
  }

  async generateStream(system: string, user: string, opts: GenerateOpts | undefined, onDelta: (t: string) => void): Promise<string> {
    const maxTokens = opts?.maxTokens ?? 1500;
    const model = opts?.model || this.brainModel || '';
    const isOpenRouter = model.includes('/');
    const ORH = { 'HTTP-Referer': 'https://teamsmrt.com', 'X-Title': 'TeamCRM' };
    try {
      let full = '';
      if (isOpenRouter && this.openrouterKey) full = await this.openaiStream('https://openrouter.ai/api/v1/chat/completions', this.openrouterKey, model, system, user, maxTokens, onDelta, ORH);
      else if (this.anthropicKey && (!model || /^claude/i.test(model))) full = await this.anthropicStream(model || 'claude-3-5-sonnet-latest', system, user, maxTokens, onDelta);
      else if (this.openaiKey && !isOpenRouter) full = await this.openaiStream('https://api.openai.com/v1/chat/completions', this.openaiKey, model || 'gpt-4o-mini', system, user, maxTokens, onDelta);
      else throw new Error('нет бэкенда для стрима');
      if (full && full.trim()) return full;
      throw new Error('пустой поток');
    } catch (e) {
      // стрим не удался → обычная генерация (полный набор фолбэков) одним куском, чтобы не терять ответ
      providerLog.warn(`generateStream fallback: ${(e as Error).message}`);
      const full = await this.generate(system, user, opts);
      if (full) onDelta(full);
      return full;
    }
  }

  async embed(text: string): Promise<number[]> {
    const input = text.slice(0, 8000);
    // OpenAI напрямую, иначе через OpenRouter (та же модель text-embedding-3-small → 1536, совместимо
    // с уже проиндексированными чанками). Так ключ OpenRouter полностью заменяет OpenAI и для поиска.
    if (this.openaiKey) {
      try { const v = await this.embedVia('https://api.openai.com/v1/embeddings', this.openaiKey, 'text-embedding-3-small', input); if (v) return v; } catch { /* фолбэк ниже */ }
    }
    if (this.openrouterKey) {
      try {
        const v = await this.embedVia('https://openrouter.ai/api/v1/embeddings', this.openrouterKey, 'openai/text-embedding-3-small', input, { 'HTTP-Referer': 'https://teamsmrt.com', 'X-Title': 'TeamCRM' });
        if (v) return v;
      } catch { /* mock ниже */ }
    }
    return mockEmbed(text);
  }

  /** Эмбеддинг через OpenAI-совместимый endpoint; возвращает null при неверной размерности (страховка колонки vector(1536)). */
  private async embedVia(url: string, key: string, model: string, input: string, extraHeaders: Record<string, string> = {}): Promise<number[] | null> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json', ...extraHeaders },
      body: JSON.stringify({ model, input }),
    });
    const json: any = await res.json();
    const vec = json?.data?.[0]?.embedding;
    return Array.isArray(vec) && vec.length === EMBED_DIM ? vec : null;
  }
}
