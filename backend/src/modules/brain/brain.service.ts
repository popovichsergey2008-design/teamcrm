import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { RedisService } from '../../cache/redis.service';
import { AiService } from '../ai/ai.service';
import { PromptsService } from '../prompts/prompts.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { BrainRepository } from './brain.repository';

const ANSWER_TTL = 6 * 3600; // кэш ответов — 6ч
const SEMANTIC_THRESHOLD = 0.93; // «похожий» вопрос
const normalize = (q: string) => q.toLowerCase().replace(/\s+/g, ' ').trim();

// Фолбэк системного промпта, если PromptOps-дефолт недоступен (миграция не накатана / ключ удалён).
const SYSTEM_FALLBACK = [
  'Ты — «корпоративный разум» компании: отвечаешь новым и текущим сотрудникам на основе архива задач, комментариев и регламентов.',
  'Отвечай ТОЛЬКО на основе предоставленного КОНТЕКСТА. Если в контексте нет ответа — честно скажи, что в базе знаний не нашлось материалов, и не выдумывай.',
  'Дай чёткий пошаговый ответ на русском. Ссылайся на источники в квадратных скобках, например [1], [2], соответствующих номерам в контексте.',
].join(' ');

@Injectable()
export class BrainService {
  constructor(
    private readonly repo: BrainRepository,
    private readonly knowledge: KnowledgeService,
    private readonly ai: AiService,
    private readonly prompts: PromptsService,
    private readonly redis: RedisService,
  ) {}

  async start(tenantId: string, userId: string) {
    const c = await this.repo.createConversation(tenantId, userId);
    return { id: c!.id };
  }

  list(tenantId: string, userId: string) {
    return this.repo.listConversations(tenantId, userId);
  }

  async messages(tenantId: string, userId: string, conversationId: string) {
    if (!(await this.repo.conversationOwned(tenantId, userId, conversationId))) throw AppException.notFound('Диалог не найден');
    return this.repo.listMessages(conversationId);
  }

  /** RAG-конвейер: поиск top-k → сборка контекста → LLM → ответ с цитатами. Изоляция по tenant/пользователю. */
  async ask(tenantId: string, userId: string, conversationId: string, question: string, projectId?: string) {
    const conv = await this.repo.conversationOwned(tenantId, userId, conversationId);
    if (!conv) throw AppException.notFound('Диалог не найден');
    const q = question.trim();
    if (q.length < 2) throw AppException.validation('Слишком короткий вопрос');

    await this.repo.addMessage(conversationId, 'user', q, null);
    await this.repo.setTitle(conversationId, q);

    // PromptOps: действующая версия системного промпта (tenant-override > глобальный дефолт).
    // versionId включён в ключ кэша — смена версии сразу даёт свежий ответ.
    const prompt = await this.prompts.resolve(tenantId, 'brain.system', {}, userId);
    const system = prompt?.body ?? SYSTEM_FALLBACK;
    const versionId = prompt?.versionId ?? null;
    const versionKey = versionId ?? 'default';

    // 1) точный кэш (Redis) — идентичный вопрос в рамках арендатора, проекта И версии промпта
    const scopeKey = projectId ? `p${projectId}` : 'all';
    const exactKey = `brain:ans:${tenantId}:${scopeKey}:v${versionKey}:${createHash('sha256').update(normalize(q)).digest('hex')}`;
    const exact = await this.redis.getJson<{ answer: string; citations: any[] }>(exactKey).catch(() => null);
    if (exact) return this.finish(tenantId, conversationId, exact.answer, exact.citations, 'exact', versionId);

    // 2) эмбеддинг вопроса — переиспользуется для семантического кэша И для поиска
    const vec = await this.ai.embed(tenantId, q, 'embedding');

    // 3) семантический кэш (pgvector) — только для общего поиска (не проектного), в разрезе версии промпта
    if (!projectId) {
      const sem = await this.repo.cacheLookup(tenantId, vec, versionId).catch(() => null);
      if (sem && sem.score >= SEMANTIC_THRESHOLD) {
        const citations = sem.citations ?? [];
        await this.redis.setJson(exactKey, { answer: sem.answer, citations }, ANSWER_TTL).catch(() => undefined);
        return this.finish(tenantId, conversationId, sem.answer, citations, 'semantic', versionId);
      }
    }

    // 4) промах кэша → RAG + LLM (в рамках проекта, если задан)
    const hits = await this.knowledge.searchByVector(tenantId, vec, 6, projectId);
    const seen = new Set<string>();
    const citations: { sourceType: string; sourceId: string; title: string | null }[] = [];
    for (const h of hits) {
      const key = `${h.sourceType}:${h.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({ sourceType: h.sourceType, sourceId: h.sourceId, title: h.title });
    }

    let answer: string;
    if (!hits.length) {
      answer = 'В базе знаний не нашлось материалов по этому вопросу. Возможно, стоит переиндексировать знания или задать вопрос иначе.';
    } else {
      const context = hits.map((h, i) => `[${i + 1}] (${h.sourceType}${h.title ? `: ${h.title}` : ''})\n${h.snippet}`).join('\n\n');
      answer = (await this.ai.generate(tenantId, system, `Вопрос: ${q}\n\nКОНТЕКСТ:\n${context}`, 'brain', {
        promptVersionId: versionId, model: prompt?.model, params: prompt?.params,
      })).trim() || 'Не удалось сформировать ответ.';
    }

    // сохранить в кэши (семантический — только для общего разреза, в разрезе версии промпта)
    await this.redis.setJson(exactKey, { answer, citations }, ANSWER_TTL).catch(() => undefined);
    if (hits.length && !projectId) await this.repo.cacheStore(tenantId, q, vec, answer, citations, versionId).catch(() => undefined);

    return this.finish(tenantId, conversationId, answer, citations, 'miss', versionId);
  }

  /**
   * Стрим-версия ask(): тот же RAG-конвейер, но ответ LLM отдаётся по фрагментам через on.delta.
   * Кэш/«нет материалов» отдаются одним фрагментом (мгновенно). on.citations вызывается до текста.
   */
  async askStream(
    tenantId: string, userId: string, conversationId: string, question: string, projectId: string | undefined,
    on: { citations: (c: any[]) => void; delta: (t: string) => void },
  ) {
    const conv = await this.repo.conversationOwned(tenantId, userId, conversationId);
    if (!conv) throw AppException.notFound('Диалог не найден');
    const q = question.trim();
    if (q.length < 2) throw AppException.validation('Слишком короткий вопрос');

    await this.repo.addMessage(conversationId, 'user', q, null);
    await this.repo.setTitle(conversationId, q);

    const prompt = await this.prompts.resolve(tenantId, 'brain.system', {}, userId);
    const system = prompt?.body ?? SYSTEM_FALLBACK;
    const versionId = prompt?.versionId ?? null;
    const versionKey = versionId ?? 'default';

    const scopeKey = projectId ? `p${projectId}` : 'all';
    const exactKey = `brain:ans:${tenantId}:${scopeKey}:v${versionKey}:${createHash('sha256').update(normalize(q)).digest('hex')}`;
    const exact = await this.redis.getJson<{ answer: string; citations: any[] }>(exactKey).catch(() => null);
    if (exact) { on.citations(exact.citations); on.delta(exact.answer); return this.finish(tenantId, conversationId, exact.answer, exact.citations, 'exact', versionId); }

    const vec = await this.ai.embed(tenantId, q, 'embedding');

    if (!projectId) {
      const sem = await this.repo.cacheLookup(tenantId, vec, versionId).catch(() => null);
      if (sem && sem.score >= SEMANTIC_THRESHOLD) {
        const citations = sem.citations ?? [];
        await this.redis.setJson(exactKey, { answer: sem.answer, citations }, ANSWER_TTL).catch(() => undefined);
        on.citations(citations); on.delta(sem.answer);
        return this.finish(tenantId, conversationId, sem.answer, citations, 'semantic', versionId);
      }
    }

    const hits = await this.knowledge.searchByVector(tenantId, vec, 6, projectId);
    const seen = new Set<string>();
    const citations: { sourceType: string; sourceId: string; title: string | null }[] = [];
    for (const h of hits) {
      const key = `${h.sourceType}:${h.sourceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      citations.push({ sourceType: h.sourceType, sourceId: h.sourceId, title: h.title });
    }
    on.citations(citations);

    let answer: string;
    if (!hits.length) {
      answer = 'В базе знаний не нашлось материалов по этому вопросу. Возможно, стоит переиндексировать знания или задать вопрос иначе.';
      on.delta(answer);
    } else {
      const context = hits.map((h, i) => `[${i + 1}] (${h.sourceType}${h.title ? `: ${h.title}` : ''})\n${h.snippet}`).join('\n\n');
      answer = (await this.ai.generateStream(tenantId, system, `Вопрос: ${q}\n\nКОНТЕКСТ:\n${context}`, on.delta, 'brain', {
        promptVersionId: versionId, model: prompt?.model, params: prompt?.params,
      })).trim() || 'Не удалось сформировать ответ.';
    }

    await this.redis.setJson(exactKey, { answer, citations }, ANSWER_TTL).catch(() => undefined);
    if (hits.length && !projectId) await this.repo.cacheStore(tenantId, q, vec, answer, citations, versionId).catch(() => undefined);

    return this.finish(tenantId, conversationId, answer, citations, 'miss', versionId);
  }

  /** Сохраняет ответ ассистента, метерит cache-hit, возвращает результат (+ версию промпта для аудита 👍/👎). */
  private async finish(
    tenantId: string, conversationId: string, answer: string, citations: any[],
    cache: 'exact' | 'semantic' | 'miss', promptVersionId: string | null,
  ) {
    if (cache !== 'miss') await this.ai.recordUsage(tenantId, 'brain', 'cache', 0, 0, true, 0, promptVersionId);
    const saved = await this.repo.addMessage(conversationId, 'assistant', answer, citations);
    return { messageId: saved!.id, answer, citations, cached: cache !== 'miss', promptVersionId };
  }
}
