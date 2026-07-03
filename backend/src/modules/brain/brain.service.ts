import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import { BrainRepository } from './brain.repository';

const SYSTEM = [
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
  async ask(tenantId: string, userId: string, conversationId: string, question: string) {
    const conv = await this.repo.conversationOwned(tenantId, userId, conversationId);
    if (!conv) throw AppException.notFound('Диалог не найден');
    const q = question.trim();
    if (q.length < 2) throw AppException.validation('Слишком короткий вопрос');

    const hits = await this.knowledge.search(tenantId, q, 6);
    await this.repo.addMessage(conversationId, 'user', q, null);
    await this.repo.setTitle(conversationId, q);

    // дедуп источников для цитат (несколько чанков одного источника → одна цитата)
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
      const context = hits
        .map((h, i) => `[${i + 1}] (${h.sourceType}${h.title ? `: ${h.title}` : ''})\n${h.snippet}`)
        .join('\n\n');
      const userContent = `Вопрос: ${q}\n\nКОНТЕКСТ:\n${context}`;
      answer = (await this.ai.generate(tenantId, SYSTEM, userContent)).trim()
        || 'Не удалось сформировать ответ.';
    }

    const saved = await this.repo.addMessage(conversationId, 'assistant', answer, citations);
    return { messageId: saved!.id, answer, citations };
  }
}
