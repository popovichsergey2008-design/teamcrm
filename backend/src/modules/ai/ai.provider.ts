import { createHash } from 'crypto';

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

export interface AiProvider {
  name: string;
  transcribe(audioRefOrText: string): Promise<string>;
  /** schemaHint — версионируемая инструкция парсера (PromptOps); при отсутствии берётся встроенный дефолт. */
  parseIntents(maskedText: string, schemaHint?: string): Promise<unknown>;
  embed(text: string): Promise<number[]>;
  /** Аналитическая генерация (AI Brain): system + user → текст ответа. */
  generate(system: string, user: string, opts?: GenerateOpts): Promise<string>;
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

export class MockAiProvider implements AiProvider {
  name = 'mock';
  async transcribe(audioRefOrText: string): Promise<string> {
    // текстовый дейлик: ref в формате "text:<содержимое>" → транскрипт = содержимое
    if (audioRefOrText.startsWith('text:')) return audioRefOrText.slice(5);
    // голос без реального Whisper — канонический заглушечный транскрипт
    return audioRefOrText;
  }
  async parseIntents(maskedText: string, _schemaHint?: string): Promise<unknown> {
    void _schemaHint; // mock понимает мини-DSL и не нуждается в инструкции
    return parseMockDsl(maskedText);
  }
  async embed(text: string): Promise<number[]> {
    return mockEmbed(text);
  }
  async generate(_system: string, user: string, _opts?: GenerateOpts): Promise<string> {
    // mock: без LLM — короткий ответ, ссылающийся на найденные источники (цитаты дают ретрив)
    void _system; void _opts;
    const hasCtx = /\[\d+\]/.test(user);
    return hasCtx
      ? 'На основе найденных материалов из архива компании (см. источники ниже). [1]\n\n(Демо-ответ: подключите OPENAI_API_KEY или ANTHROPIC_API_KEY для реальной генерации.)'
      : 'В базе знаний не нашлось релевантных материалов по этому вопросу.';
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

  /** Вызов OpenAI-совместимого chat/completions (OpenAI и OpenRouter — один формат). */
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
    const json: any = await res.json();
    return json?.choices?.[0]?.message?.content ?? '';
  }

  async transcribe(audioRefOrText: string): Promise<string> {
    if (audioRefOrText.startsWith('text:')) return audioRefOrText.slice(5);
    if (!this.openaiKey) return audioRefOrText;
    // audioRefOrText — URL временного аудио (Telegram file). Скачиваем и шлём в Whisper.
    const audio = await fetch(audioRefOrText).then((r) => r.arrayBuffer());
    const form = new FormData();
    form.append('file', new Blob([audio]), 'audio.ogg');
    form.append('model', 'whisper-1');
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.openaiKey}` },
      body: form,
    });
    const json: any = await res.json();
    return json.text ?? '';
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
    const OR = { url: 'https://openrouter.ai/api/v1/chat/completions', headers: { 'HTTP-Referer': 'https://teamsmrt.com', 'X-Title': 'TeamCRM' } };

    // 1) Явно выбрана модель OpenRouter.
    if (isOpenRouter && this.openrouterKey) {
      try { const t = await this.chatCompletion(OR.url, this.openrouterKey, model, system, user, maxTokens, OR.headers); if (t) return t; } catch { /* фолбэк ниже */ }
    }
    // 2) Anthropic — для claude-* или когда модель не задана.
    if (this.anthropicKey && (!model || /^claude/i.test(model))) {
      try {
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { 'x-api-key': this.anthropicKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts?.model || this.brainModel || 'claude-3-5-sonnet-latest',
            max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
          }),
        });
        const json: any = await res.json();
        const t = json?.content?.[0]?.text ?? '';
        if (t) return t;
      } catch { /* фолбэк ниже */ }
    }
    // 3) OpenAI.
    if (this.openaiKey && !isOpenRouter) {
      try { const t = await this.chatCompletion('https://api.openai.com/v1/chat/completions', this.openaiKey, model || 'gpt-4o-mini', system, user, maxTokens); if (t) return t; } catch { /* фолбэк ниже */ }
    }
    // 4) OpenRouter как общий фолбэк (в т.ч. если задан только его ключ).
    if (this.openrouterKey) {
      try { const t = await this.chatCompletion(OR.url, this.openrouterKey, isOpenRouter ? model : (model || 'meta-llama/llama-3.3-70b-instruct:free'), system, user, maxTokens, OR.headers); if (t) return t; } catch { /* mock ниже */ }
    }
    return new MockAiProvider().generate(system, user, opts);
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
