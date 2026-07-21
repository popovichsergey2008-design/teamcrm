import { Injectable, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { NlService } from '../nl/nl.service';
import { InboxRepository } from './inbox.repository';

@Injectable()
export class InboxService {
  private readonly log = new Logger('Inbox');

  constructor(
    private readonly repo: InboxRepository,
    private readonly nl: NlService,
    private readonly ai: AiService,
  ) {}

  // ── каналы ──
  async createSource(tenantId: string, userId: string, label?: string, defaultProjectId?: string) {
    const token = randomBytes(24).toString('hex');
    const s = await this.repo.createSource({ tenantId, label: label?.trim() || null, token, defaultProjectId: defaultProjectId || null, createdBy: userId });
    return { id: s!.id, token: s!.token, label: s!.label };
  }
  listSources(tenantId: string) {
    return this.repo.listSources(tenantId);
  }
  async deleteSource(tenantId: string, id: string) {
    await this.repo.deleteSource(tenantId, id);
    return { deleted: true };
  }

  // ── приём входящего сообщения (публичный вебхук) ──
  /** Извлекает from/subject/body из разных форматов провайдеров почты (Mailgun/Postmark/generic). */
  private extract(payload: any): { from: string | null; subject: string | null; body: string } {
    const p = payload ?? {};
    const pick = (...keys: string[]) => { for (const k of keys) if (p[k] != null && String(p[k]).trim()) return String(p[k]); return ''; };
    const from = pick('from', 'sender', 'From', 'from_email') || null;
    const subject = pick('subject', 'Subject') || null;
    const body = pick('body', 'text', 'Body', 'TextBody', 'body-plain', 'stripped-text', 'message', 'html', 'HtmlBody');
    return { from, subject: subject ? subject.slice(0, 500) : null, body };
  }

  async receive(token: string, payload: any) {
    const source = await this.repo.sourceByToken(token);
    if (!source) return { received: false };
    const { from, subject, body } = this.extract(payload);
    if (!body.trim() && !subject) return { received: true, ignored: 'empty' };
    const item = await this.repo.createItem({
      tenantId: source.tenant_id, sourceId: source.id, sender: from ? from.slice(0, 320) : null, subject, body: (body || subject || '').slice(0, 20000),
    });
    void this.parseItem(source, item!.id, subject, body);
    return { received: true, itemId: item!.id };
  }

  // ── голосовая заметка (надиктовал в приложении) ──
  /** Аудио-запись → Whisper → черновик задачи на ревью (тот же конвейер, что письмо; без канала). */
  async captureVoice(tenantId: string, userId: string, audio: Buffer, filename: string, defaultProjectId?: string) {
    const text = (await this.ai.transcribeAudio(tenantId, audio, filename)).trim();
    if (!text) throw AppException.validation('Речь не распознана. Нужен ключ OpenAI (Whisper) в «Интеграции → ИИ».');
    const item = await this.repo.createItem({
      tenantId, sourceId: null, sender: 'Голосовая заметка', subject: null, body: text.slice(0, 20000),
    });
    void this.parseItem({ tenant_id: tenantId, created_by: userId, default_project_id: defaultProjectId || null }, item!.id, null, text);
    return { itemId: item!.id, text };
  }

  /** Фоново распознаёт задачу из сообщения (NL-ядро) и сохраняет черновик на ревью. */
  private async parseItem(source: { tenant_id: string; created_by: string | null; default_project_id: string | null }, itemId: string, subject: string | null, body: string) {
    try {
      const text = [subject, body].filter(Boolean).join('\n').slice(0, 4000);
      const draft = await this.nl.parse(source.tenant_id, source.created_by ?? '', text);
      if (draft.intent === 'create_task' && draft.task) {
        const task = draft.task;
        if (!task.projectId && source.default_project_id) task.projectId = source.default_project_id;
        await this.repo.setItemResult(itemId, 'pending', { task });
      } else {
        // не распознали действенную задачу — помечаем «проигнорировано» (в ревью не мешает)
        await this.repo.setItemResult(itemId, 'ignored', { note: draft.note ?? null });
      }
    } catch (e) {
      this.log.warn(`parseItem ${itemId} failed: ${(e as Error).message}`);
      await this.repo.setItemResult(itemId, 'pending', null); // остаётся на ручную разборку
    }
  }

  // ── ревью черновиков ──
  listItems(tenantId: string, status = 'pending') {
    return this.repo.listItems(tenantId, status);
  }

  /** Подтвердить черновик (возможно отредактированный) → создать задачу через NL-ядро. */
  async confirm(tenantId: string, userId: string, itemId: string, task: any) {
    const item = await this.repo.getItem(tenantId, itemId);
    if (!item) throw AppException.notFound('Сообщение не найдено');
    if (item.status === 'created') throw AppException.conflict('Задача уже создана');
    const result = await this.nl.apply(tenantId, userId, { intent: 'create_task', task });
    await this.repo.markCreated(tenantId, itemId, (result as any).task.id);
    return { created: true, task: (result as any).task };
  }

  async dismiss(tenantId: string, itemId: string) {
    const item = await this.repo.getItem(tenantId, itemId);
    if (!item) throw AppException.notFound('Сообщение не найдено');
    await this.repo.markDismissed(tenantId, itemId);
    return { dismissed: true };
  }
}
