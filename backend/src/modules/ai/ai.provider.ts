/**
 * Провайдеры AI. Реальные Whisper/Anthropic используются при наличии ключей в env,
 * иначе — детерминированный mock (конвейер полностью работает и тестируется без секретов).
 * Парсер mock'а понимает мини-DSL: "#<id> done 120m", "#<id> progress blocker: ...".
 */
export interface AiProvider {
  name: string;
  transcribe(audioRefOrText: string): Promise<string>;
  parseIntents(maskedText: string): Promise<unknown>;
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
  async parseIntents(maskedText: string): Promise<unknown> {
    return parseMockDsl(maskedText);
  }
}

/** Реальный провайдер (OpenAI Whisper + Anthropic) — активен только при наличии ключей. */
export class RealAiProvider implements AiProvider {
  name = 'real';
  constructor(
    private readonly openaiKey: string | undefined,
    private readonly anthropicKey: string | undefined,
    private readonly model: string,
  ) {}

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

  async parseIntents(maskedText: string): Promise<unknown> {
    if (!this.anthropicKey) return new MockAiProvider().parseIntents(maskedText);
    const schemaHint =
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
        system: schemaHint,
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
}
