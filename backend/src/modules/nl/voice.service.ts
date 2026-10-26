import { Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { extractAudioChunks } from '../meetings/audio.util';
import { NlService } from './nl.service';
import { VoiceJobRow, VoiceRepository } from './voice.repository';
import { DiagService } from '../diagnostics/diag.service';
import { trackBackground } from '../../common/background-work';
import { isHallucination } from '../ai/stt-hallucinations';
import { isShortCommand, NlTiming, wordCount } from './fast-path';

/** Предел Whisper на один запрос — 25 МБ; берём с запасом, дальше режем сами. */
const CHUNK_THRESHOLD = 20 * 1024 * 1024;
/** Куски по три минуты: даже плотный битрейт даёт файл заметно меньше предела. */
const CHUNK_SECONDS = 180;
/**
 * #4666: короткая запись (команда в несколько слов — десятки КБ) обрабатывается, пока
 * открыт сам запрос загрузки: ответ приходит уже с готовой задачей, без опроса
 * «как дела» каждые две секунды. Не успели — как раньше: запись сохранена, окно спросит.
 */
export const SYNC_MAX_BYTES = 400 * 1024;
export const SYNC_WAIT_MS = Number(process.env.NL_VOICE_SYNC_WAIT_MS ?? 9000);
/** До этого размера распознаём быстрой моделью (короткая речь, один запрос). */
const FAST_STT_MAX_BYTES = 1024 * 1024;

/** Обещание с потолком: не успело — `fallback`, само оно доживает в фоне. */
function within<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let t: NodeJS.Timeout | undefined;
  const late = new Promise<T>((r) => { t = setTimeout(() => r(fallback), Math.max(0, ms)); });
  return Promise.race([p, late]).finally(() => clearTimeout(t));
}

/**
 * Голосовая постановка задач: длинная запись без потерь.
 *
 * Раньше запись уходила одним синхронным запросом и разбиралась там же. Пятиминутная
 * надиктовка от этого падала дважды: тело не проходило через прокси, а расшифровка
 * с разбором не укладывалась в его таймаут. Человек, говоривший пять минут, получал
 * красную ошибку — и запись пропадала вместе с ней.
 *
 * Теперь приём и разбор разделены. Аудио сохраняется СРАЗУ и переживает любую ошибку:
 * упал Whisper, кончились деньги на ИИ, перезапустился сервер — запись на месте,
 * обработку можно повторить. Интерфейс всё это время показывает, на каком она шаге.
 */
@Injectable()
export class VoiceService {
  private readonly log = new Logger('Voice');

  constructor(
    private readonly repo: VoiceRepository,
    private readonly files: FilesService,
    private readonly ai: AiService,
    private readonly nl: NlService,
    private readonly diag: DiagService,
  ) {}

  /**
   * Принять запись. Отвечаем сразу, разбираем в фоне.
   *
   * Файл кладём в хранилище ДО всякой обработки — это главное свойство всей затеи.
   */
  async accept(
    tenantId: string, userId: string,
    file: { buffer: Buffer; originalname: string; mimetype: string },
    currentProjectId?: string | null,
    opts: { auto?: boolean } = {},
  ) {
    if (!file?.buffer?.length) throw AppException.validation('Аудио не получено');

    const t0 = Date.now();
    const stored = await this.files.upload({
      tenantId, userId,
      buffer: file.buffer,
      fileName: file.originalname || 'voice.webm',
      // Браузеры отдают запись как audio/webm;codecs=opus — приводим к базовому типу,
      // иначе проверка загрузки отбивает собственную же запись.
      contentType: (file.mimetype || 'audio/webm').split(';')[0],
      ownerKind: 'voice',
      maxBytes: 64 * 1024 * 1024,
    });

    const job = await this.repo.create(tenantId, userId, String(stored.id));
    const timing: NlTiming = { bytes: file.buffer.length, storeMs: Date.now() - t0 };
    const work = trackBackground(this.run(job, file.buffer, file.originalname || 'voice.webm', currentProjectId ?? null, { auto: opts.auto === true, timing }));
    // #4666: короткую запись дожидаемся в этом же запросе — без опроса и его пауз
    if (file.buffer.length <= SYNC_MAX_BYTES && SYNC_WAIT_MS > 0) {
      const done = await within(work.then(() => true), SYNC_WAIT_MS, false);
      if (done) {
        const fresh = await this.repo.find(tenantId, userId, String(job.id)).catch(() => null);
        if (fresh) return this.view(fresh);
      }
    }
    return this.view({ ...job, status: 'queued' });
  }

  /** Как идут дела: интерфейс спрашивает это каждые пару секунд. */
  async status(tenantId: string, userId: string, id: string) {
    const job = await this.repo.find(tenantId, userId, id);
    if (!job) throw AppException.notFound('Запись не найдена');
    return this.view(job);
  }

  /**
   * Повторить обработку.
   *
   * Ради этого аудио и хранится: ошибка ИИ не должна стоить человеку ещё десяти минут
   * диктовки. Берём файл из хранилища и проходим путь заново.
   */
  async retry(tenantId: string, userId: string, id: string, currentProjectId?: string | null) {
    const job = await this.repo.find(tenantId, userId, id);
    if (!job) throw AppException.notFound('Запись не найдена');
    if (!job.file_id) throw AppException.conflict('Исходная запись не сохранилась — придётся надиктовать заново');

    const { file, stream } = await this.files.getForDownload(tenantId, job.file_id);
    const chunks: Buffer[] = [];
    for await (const part of stream) chunks.push(Buffer.from(part));

    await this.repo.setStatus(job.id, 'queued', null);
    void trackBackground(this.run(job, Buffer.concat(chunks), file.file_name || 'voice.webm', currentProjectId ?? null));
    return this.view({ ...job, status: 'queued', error: null });
  }

  /**
   * Расшифровка и разбор.
   *
   * Ошибку не глотаем и не теряем: она сохраняется в записи человеческим языком,
   * а сама запись остаётся — с неё можно начать заново одной кнопкой.
   */
  private async run(
    job: VoiceJobRow, audio: Buffer, fileName: string, currentProjectId: string | null,
    opts: { auto?: boolean; timing?: NlTiming } = {},
  ) {
    const timing: NlTiming = opts.timing ?? { bytes: audio.length };
    const t0 = Date.now();
    try {
      await this.repo.setStatus(job.id, 'transcribing');
      const tStt = Date.now();
      const { text, seconds, model } = await this.transcribe(job.tenant_id, audio, fileName);
      Object.assign(timing, { sttMs: Date.now() - tStt, sttModel: model, chars: text.length, words: wordCount(text) });
      if (!text.trim()) {
        timing.result = 'no_speech';
        await this.repo.setStatus(job.id, 'error', 'Речь не распознана. Проверьте ключ OpenAI в «Интеграции → ИИ».');
        return;
      }
      // на тишине Whisper сочиняет «Продолжение следует…» — это не поручение
      if (text.length <= 40 && isHallucination({ start: 0, end: 0, text })) {
        timing.result = 'hallucination';
        await this.repo.setStatus(job.id, 'error', 'Не расслышал — скажите ещё раз, ближе к микрофону.');
        return;
      }
      await this.repo.setTranscript(job.id, text, seconds);

      await this.repo.setStatus(job.id, 'parsing');
      /*
        #4666: окно в авто-режиме ждёт черновики С автозаполнением (проект, руководитель,
        теги) — собираем их сразу здесь. Раньше здесь шёл обычный разбор, а окно, получив
        расшифровку, запускало его ЗАНОВО с авто — второй долгий этап того же самого.
      */
      const fast = isShortCommand(text);
      const drafts = await this.nl.parseMany(job.tenant_id, job.user_id, text, currentProjectId, {
        auto: opts.auto === true, fast, timing,
      });
      await this.repo.setDrafts(job.id, drafts);
      timing.result = 'ready';
    } catch (e) {
      const msg = (e as Error).message || 'Неизвестная ошибка';
      timing.result = 'error';
      this.log.warn(`запись ${job.id}: ${msg}`);
      await this.repo.setStatus(job.id, 'error', humanError(msg)).catch(() => undefined);
    } finally {
      // Длительности и размер — без содержимого: видно, где теряется время (#4666)
      timing.runMs = Date.now() - t0;
      timing.auto = opts.auto === true;
      this.diag.write({
        tenantId: job.tenant_id, scope: 'app', refId: `voice:${job.id}`, userId: job.user_id,
        side: 'server', event: 'voice.timing', data: timing,
      });
    }
  }

  /**
   * Текст записи. Длинное аудио режем на куски и склеиваем расшифровки.
   *
   * Порог по размеру, а не по времени: Whisper ограничен именно им, а сколько минут
   * поместится в 20 МБ, зависит от того, как браузер сжал звук.
   */
  private async transcribe(tenantId: string, audio: Buffer, fileName: string): Promise<{ text: string; seconds: number | null; model: string }> {
    if (audio.length <= CHUNK_THRESHOLD) {
      const hint = await this.nl.speechHint(tenantId).catch(() => undefined);
      const r = await this.ai.transcribeAudioWithModel(tenantId, audio, fileName, hint, { fast: audio.length <= FAST_STT_MAX_BYTES });
      return { text: (r.text || '').trim(), seconds: null, model: r.model };
    }

    const hint = await this.nl.speechHint(tenantId).catch(() => undefined);
    const { chunks, durationSec } = await extractAudioChunks(audio, fileName, CHUNK_SECONDS);
    const parts: string[] = [];
    for (const chunk of chunks) {
      // По одному куску за раз: параллельная отправка упирается в лимиты Whisper,
      // а выигрыш в минуту здесь никого не спасает.
      parts.push((await this.ai.transcribeAudio(tenantId, chunk.buffer, chunk.name, hint)) || '');
    }
    return { text: parts.join(' ').replace(/\s+/g, ' ').trim(), seconds: durationSec, model: 'whisper-1' };
  }

  private view(job: VoiceJobRow) {
    return {
      id: String(job.id),
      status: job.status,
      transcript: job.transcript ?? '',
      tasks: Array.isArray(job.drafts) ? job.drafts : [],
      error: job.error ?? null,
      durationSec: job.duration_sec ?? null,
    };
  }
}

/**
 * Причина по-русски.
 *
 * «Request failed with status code 413» человеку не говорит ничего, а именно эти
 * сообщения он видит после десяти минут диктовки — момент, когда меньше всего
 * хочется разбираться в чужих кодах ошибок.
 */
function humanError(raw: string): string {
  const m = raw.toLowerCase();
  if (m.includes('ffmpeg') || m.includes('ffprobe')) return 'Не удалось разрезать длинную запись. Попробуйте ещё раз — файл сохранён.';
  if (m.includes('413') || m.includes('too large')) return 'Запись слишком большая для распознавания. Разбейте её на части покороче.';
  if (m.includes('401') || m.includes('api key') || m.includes('unauthorized')) return 'Ключ OpenAI не принят — проверьте «Интеграции → ИИ».';
  if (m.includes('429') || m.includes('quota') || m.includes('rate limit')) return 'Сервис распознавания перегружен или кончился лимит. Запись сохранена — повторите позже.';
  if (m.includes('timeout') || m.includes('etimedout') || m.includes('aborted')) return 'Распознавание не ответило вовремя. Запись сохранена — попробуйте повторить.';
  return `Не удалось обработать запись: ${raw.slice(0, 200)}`;
}
