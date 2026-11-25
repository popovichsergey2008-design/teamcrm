import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { AiService } from '../ai/ai.service';
import { FilesService } from '../files/files.service';
import { extractText } from '../knowledge/file-text';
import { xlsxFrom } from '../anthill/xlsx';
import { localParts } from '../assistant/ping-rules';
import { Actor, ProactiveService } from '../proactive/proactive.service';
import { ProactiveScheduler } from '../proactive/proactive.scheduler';
import { ProactiveRepository, type ProposalRow } from '../proactive/proactive.repository';
import { SecretaryDocsRepository } from './secretary-docs.repository';
import {
  advanceReportRows, ContractReview, contractRules, DATE_KIND_LABEL, DateKind, docAdvice, docCardText, DOC_KINDS, docReminder,
  greetingDue, greetingTemplate, looksLikeContract, markReminded, mergeRisks, nextOccurrence, occasion, parseContractAi, parseReceiptAi,
  RECEIPT_CATEGORIES,
} from './secretary-docs.rules';

type Me = { tenantId: string; userId: string; role: string };

const CONTRACT_SYSTEM = `Ты — юрист, который проверяет договор для руководителя небольшой компании в России.
Найди пункты, опасные для НАШЕЙ стороны (мы — та сторона, которая получила договор на проверку; если неясно — оцени риски для обеих сторон и скажи это в summary).
Ищи: одностороннее изменение условий и отказ, несимметричные неустойки и штрафы, ограничение ответственности контрагента, автопролонгацию,
полную предоплату, молчаливую приёмку, подсудность в чужом городе, переход прав на результат, скрытые платежи, размытые сроки и критерии приёмки,
отсутствие важных пунктов (порядок оплаты, сроки, ответственность, расторжение).
Пиши по-русски, простыми словами, без воды. Цитаты — дословно из текста (до 300 символов).
Ответ — ТОЛЬКО JSON без пояснений:
{"summary":"2–3 предложения: что это за договор и главный вывод","parties":["сторона 1","сторона 2"],"subject":"предмет","amount":"цена/порядок оплаты или null","term":"срок действия или null",
"risks":[{"level":"high|medium|low","topic":"короткая тема","quote":"дословная цитата","why":"чем опасно для нас","fix":"как переписать"}],
"missing":["чего не хватает в договоре"]}`;

const RECEIPT_SYSTEM = `Ты распознаёшь кассовый чек, квитанцию или счёт для авансового отчёта.
Верни ТОЛЬКО JSON: {"date":"ДД.ММ.ГГГГ","seller":"название продавца","inn":"ИНН продавца или пусто","total":итоговая сумма числом,"vat":"сумма НДС числом или пусто","currency":"RUB|USD|EUR|…","category":"taxi|transport|hotel|food|office|fuel|communication|other"}
Итог — сумма к оплате (ИТОГ/ИТОГО/К ОПЛАТЕ), не сумма отдельной позиции. Если на изображении нет чека или сумма не читается — {"total":null}.`;

const GREETING_SYSTEM = `Ты помогаешь руководителю поздравить клиента или партнёра. Напиши короткое тёплое поздравление по-русски от имени компании:
3–5 предложений, без канцелярита и пафоса, без смайлов, обращение по имени (если оно есть), в конце «С уважением,» без подписи.
Только текст поздравления.`;

/**
 * Функции секретаря из таблицы Бориса (#1476): сроки документов (F20), поздравления
 * клиентам (F11), проверка договора (F21), чеки → авансовый отчёт (F24).
 *
 * Напоминания и поздравления — карточками ящика секретаря (ProactiveService): там уже
 * есть тишина, лимиты, «отложить» и доставка в push/Telegram. Сами ничего не отправляем
 * клиентам — поздравление остаётся черновиком, человек копирует и отправляет сам.
 */
@Injectable()
export class SecretaryDocsService implements OnModuleInit {
  private readonly log = new Logger('SecretaryDocs');

  constructor(
    private readonly repo: SecretaryDocsRepository,
    private readonly ai: AiService,
    private readonly files: FilesService,
    private readonly proactive: ProactiveService,
    private readonly scheduler: ProactiveScheduler,
    private readonly proactiveRepo: ProactiveRepository,
  ) {}

  onModuleInit(): void {
    this.proactive.register({ skill: 'docs', execute: (a, p, action) => this.executeDoc(a, p, action) });
    this.proactive.register({ skill: 'greeting', execute: (a, p, action) => this.executeGreeting(a, p, action) });
    this.scheduler.add('сроки документов', () => this.sweepDocs());
    this.scheduler.add('даты клиентов', () => this.sweepGreetings());
  }

  // ───────────────────────── F20: сроки документов ─────────────────────────

  private docView(r: any) {
    return {
      id: String(r.id), kind: r.kind, title: r.title, expiresOn: r.expires_on, remindDays: r.remind_days ?? [],
      note: r.note, renewedAt: r.renewed_at, createdAt: r.created_at,
    };
  }

  private cleanDoc(dto: any, partial: boolean) {
    const out: { kind?: string; title?: string; expiresOn?: string; remindDays?: number[]; note?: string | null } = {};
    if (dto.kind !== undefined) out.kind = (DOC_KINDS as readonly string[]).includes(dto.kind) ? dto.kind : 'other';
    if (dto.title !== undefined) out.title = String(dto.title ?? '').trim().slice(0, 160);
    if (dto.expiresOn !== undefined) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dto.expiresOn))) throw AppException.validation('Укажите дату окончания');
      out.expiresOn = String(dto.expiresOn);
    }
    if (dto.remindDays !== undefined) {
      const days = (Array.isArray(dto.remindDays) ? dto.remindDays : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0 && n <= 365);
      out.remindDays = [...new Set<number>(days)].sort((a, b) => b - a).slice(0, 6);
      if (!out.remindDays.length) out.remindDays = [30, 7, 1];
    }
    if (dto.note !== undefined) out.note = dto.note ? String(dto.note).trim().slice(0, 500) : null;
    if (!partial) {
      if (!out.expiresOn) throw AppException.validation('Укажите дату окончания');
      out.kind = out.kind ?? 'other';
      out.title = out.title || '';
    }
    return out;
  }

  async docs(me: Me) {
    return (await this.repo.docs(me.tenantId, me.userId)).map((r) => this.docView(r));
  }

  async addDoc(me: Me, dto: any) {
    const v = this.cleanDoc(dto, false);
    const row = await this.repo.addDoc(me.tenantId, me.userId, {
      kind: v.kind!, title: v.title || '', expiresOn: v.expiresOn!, remindDays: v.remindDays ?? [30, 7, 1], note: v.note ?? null,
    });
    // добавили документ, у которого срок уже близко, — напомним сразу, а не на следующем проходе
    void this.sweepDocs(String(row!.id)).catch(() => undefined);
    return this.docView(row);
  }

  async updateDoc(me: Me, id: string, dto: any) {
    const v = this.cleanDoc(dto, true);
    const row = await this.repo.updateDoc(me.tenantId, me.userId, id, { ...v, renewed: typeof dto.renewed === 'boolean' ? dto.renewed : undefined });
    if (!row) throw AppException.notFound('Документ не найден');
    void this.sweepDocs(String(row.id)).catch(() => undefined);
    return this.docView(row);
  }

  async removeDoc(me: Me, id: string) {
    if (!(await this.repo.removeDoc(me.tenantId, me.userId, id))) throw AppException.notFound('Документ не найден');
    return { removed: true };
  }

  /** Проход планировщика: напоминания о сроках в местное дневное время человека (9–21). */
  async sweepDocs(onlyId?: string): Promise<void> {
    const rows = (await this.repo.dueDocs()).filter((r) => !onlyId || String(r.id) === onlyId);
    const tzCache = new Map<string, string>();
    for (const r of rows) {
      const key = `${r.tenant_id}:${r.user_id}`;
      if (!tzCache.has(key)) tzCache.set(key, await this.proactiveRepo.timezoneOf(String(r.tenant_id), String(r.user_id)));
      const { hour, date } = localParts(new Date(), tzCache.get(key)!);
      if (!onlyId && (hour < 9 || hour >= 21)) continue;
      const hit = docReminder(r, date);
      if (hit === null) continue;
      const text = docCardText(r, hit, date);
      await this.proactive.propose({
        tenantId: String(r.tenant_id), userId: String(r.user_id), skill: 'docs', kind: r.kind,
        sourceType: 'doc_deadline', sourceId: String(r.id), sourceLabel: 'Сроки документов', sourceLink: '/secretary/docs',
        title: text.title, summary: text.summary, why: 'Вы просили напомнить о сроке этого документа.', recommend: docAdvice(r.kind),
        effect: '«Продлил» — напоминания по этому документу прекратятся.',
        priority: text.priority, confidence: 1,
        actions: [
          { key: 'renewed', label: 'Продлил', primary: true },
          { key: 'open', label: 'Сроки документов', link: '/secretary/docs' },
        ],
        payload: { docId: String(r.id), expiresOn: r.expires_on, hit },
        fingerprint: `doc:${r.id}:${r.expires_on}:${hit}`,
      });
      await this.repo.setReminded(String(r.id), markReminded(r, hit));
    }
  }

  private async executeDoc(a: Actor, p: ProposalRow, action: string) {
    const id = String(p.payload.docId ?? '');
    if (action === 'renewed') {
      const row = await this.repo.updateDoc(a.tenantId, a.userId, id, { renewed: true });
      if (!row) throw AppException.notFound('Документ уже удалён');
      return { text: 'Отмечено: продлён. Новую дату можно указать в «Сроках документов».', link: '/secretary/docs' };
    }
    throw AppException.validation('Такого действия нет');
  }

  // ───────────────────────── F11: поздравления клиентам ─────────────────────────

  /** Проход: накануне праздника (или в сам день, если накануне не успели) — карточка с черновиком. */
  async sweepGreetings(): Promise<void> {
    const rows = await this.repo.dueDates();
    for (const r of rows) {
      if (!r.to_user) continue;
      const tenantId = String(r.tenant_id); const userId = String(r.to_user);
      const tz = await this.proactiveRepo.timezoneOf(tenantId, userId);
      const { hour, date } = localParts(new Date(), tz);
      if (hour < 9 || hour >= 21) continue;
      const next = nextOccurrence(r.month, r.day, date);
      if (!greetingDue(next.days)) continue;
      const fingerprint = `greet:${r.id}:${next.year}`;
      if (await this.repo.proposalExists(tenantId, userId, fingerprint)) continue;
      const subject = { kind: r.kind, title: r.title, person: r.person, client: r.client, years: r.year ? next.year - r.year : null };
      const what = occasion(subject);
      const body = await this.greetingText(tenantId, subject, what);
      const when = next.days === 0 ? 'сегодня' : 'завтра';
      const label = DATE_KIND_LABEL[r.kind as DateKind] ?? 'Важная дата';
      await this.proactive.propose({
        tenantId, userId, skill: 'greeting', kind: r.kind,
        sourceType: 'client_date', sourceId: String(r.id), sourceLabel: `Клиент «${r.client}»`, sourceLink: `/clients/${r.client_id}`,
        title: `${when[0].toUpperCase()}${when.slice(1)} ${what}`.slice(0, 200),
        summary: body,
        why: `${label} отмечен в карточке клиента «${r.client}»${r.client_owner ? ', вы — ответственный' : ''}.`,
        recommend: 'Поправьте текст под себя и отправьте клиенту удобным способом.',
        effect: 'Сами мы ничего клиенту не отправляем: «Скопировать» кладёт текст в буфер.',
        priority: next.days === 0 ? 1 : 2, confidence: 1,
        actions: [
          { key: 'copy', label: 'Скопировать', primary: true },
          { key: 'done', label: 'Поздравил' },
          { key: 'client', label: 'Карточка клиента', link: `/clients/${r.client_id}` },
        ],
        payload: { editable: true, body, clientId: String(r.client_id), dateId: String(r.id) },
        fingerprint,
        expiresAt: new Date(Date.now() + (next.days + 2) * 86_400_000),
      });
    }
  }

  private async greetingText(tenantId: string, s: Parameters<typeof greetingTemplate>[0], what: string): Promise<string> {
    const fallback = greetingTemplate(s);
    try {
      if (!(await this.ai.hasModel(tenantId)) || (await this.ai.limitExhausted(tenantId))) return fallback;
      const text = (await this.ai.generate(
        tenantId, GREETING_SYSTEM,
        `Повод: ${what}.${s.person ? ` Кого поздравляем: ${s.person}.` : ''} Компания клиента: «${s.client}».`,
        'client_greeting', { maxTokens: 400, timeoutMs: 30_000 },
      )).trim();
      return text.length > 40 && text.length < 1500 ? text : fallback;
    } catch {
      return fallback;
    }
  }

  private async executeGreeting(_a: Actor, _p: ProposalRow, action: string) {
    if (action === 'copy') return { text: 'Текст скопирован — вставьте его в письмо или мессенджер клиента.', keepOpen: true };
    if (action === 'done') return { text: 'Отмечено: поздравили.' };
    throw AppException.validation('Такого действия нет');
  }

  // ───────────────────────── F21: проверка договора ─────────────────────────

  private async fileBuffer(tenantId: string, fileId: string): Promise<Buffer> {
    const { stream } = await this.files.getForDownload(tenantId, fileId);
    const chunks: Buffer[] = [];
    for await (const c of stream as AsyncIterable<Buffer>) chunks.push(Buffer.from(c));
    return Buffer.concat(chunks);
  }

  private async mustRead(me: Me, fileId: string) {
    // чужой проект, чужая переписка — «не найден», как при скачивании
    if (!(await this.files.canDownload(me.tenantId, fileId, { userId: me.userId, role: me.role }))) throw AppException.notFound('Файл не найден');
    const meta = await this.files.meta(me.tenantId, fileId);
    if (!meta) throw AppException.notFound('Файл не найден');
    return meta;
  }

  async contractReview(me: Me, fileId: string, force = false): Promise<ContractReview & { fileName: string; checkedAt: string; cached: boolean }> {
    const meta = await this.mustRead(me, fileId);
    if (!force) {
      const saved = await this.repo.review(me.tenantId, fileId);
      if (saved) return { ...saved.result, fileName: meta.file_name, checkedAt: saved.created_at, cached: true };
    }
    if (Number(meta.size_bytes) > 15 * 1024 * 1024) throw AppException.validation('Файл больше 15 МБ — проверить не получится');
    const got = await extractText(await this.fileBuffer(me.tenantId, fileId), meta.file_name, meta.content_type);
    const text = got?.text?.trim() ?? '';
    if (text.length < 200) {
      throw AppException.validation('В файле нет текста: это скан или картинка. Загрузите договор в Word или PDF с текстовым слоем.');
    }
    const rules = contractRules(text);
    let review: ContractReview = {
      summary: looksLikeContract(text) ? '' : 'Похоже, это не договор — проверка по типовым рискам договоров может быть неточной.',
      parties: [], subject: null, amount: null, term: null, risks: rules, missing: [], rulesOnly: true,
    };
    let model: string | null = null;
    if ((await this.ai.hasModel(me.tenantId)) && !(await this.ai.limitExhausted(me.tenantId))) {
      try {
        const r = await this.ai.generateWithModel(me.tenantId, CONTRACT_SYSTEM, `Договор «${meta.file_name}»:\n\n${text.slice(0, 60_000)}`, 'contract_review', { maxTokens: 2500, timeoutMs: 120_000 });
        const parsed = r.degraded ? null : parseContractAi(r.text);
        if (parsed) {
          review = { ...parsed, summary: parsed.summary || review.summary, risks: mergeRisks(parsed.risks, rules), rulesOnly: false };
          model = r.model;
        }
      } catch (e) {
        this.log.warn(`договор ${fileId}: ${(e as Error).message}`);
      }
    }
    if (review.rulesOnly && !review.summary) {
      review.summary = rules.length
        ? `Проверено по типовым рискам без ИИ: найдено пунктов — ${rules.length}. Полная проверка — с подключённым ключом ИИ.`
        : 'По типовым рискам ничего не нашли. Полная проверка — с подключённым ключом ИИ.';
    }
    await this.repo.saveReview(me.tenantId, fileId, me.userId, review, model);
    return { ...review, fileName: meta.file_name, checkedAt: new Date().toISOString(), cached: false };
  }

  // ───────────────────────── F24: чеки → авансовый отчёт ─────────────────────────

  private receiptView(r: any) {
    return {
      id: String(r.id), fileId: r.file_id ? String(r.file_id) : null, fileName: r.file_name, contentType: r.content_type,
      status: r.status, spentOn: r.spent_on, seller: r.seller, sellerInn: r.seller_inn,
      total: r.total !== null && r.total !== undefined ? Number(r.total) : null, vat: r.vat !== null && r.vat !== undefined ? Number(r.vat) : null,
      currency: r.currency, category: r.category ?? 'other', purpose: r.purpose, error: r.error, createdAt: r.created_at,
    };
  }

  async receipts(me: Me, from: string | null, to: string | null) {
    return (await this.repo.receipts(me.tenantId, me.userId, from, to)).map((r) => this.receiptView(r));
  }

  /** Новый чек: файл уже загружен (owner_kind 'receipt') — распознаём сразу; без файла — пустая строка для ручного ввода. */
  async addReceipt(me: Me, fileId: string | null) {
    if (fileId) {
      const meta = await this.mustRead(me, fileId);
      if (String(meta.uploaded_by) !== String(me.userId)) throw AppException.forbidden('Чек можно добавить только из своего файла');
    }
    const id = await this.repo.addReceipt(me.tenantId, me.userId, fileId);
    if (fileId) await this.recognize(me, id);
    return this.receiptView(await this.repo.receipt(me.tenantId, me.userId, id));
  }

  async recognize(me: Me, id: string) {
    const row = await this.repo.receipt(me.tenantId, me.userId, id);
    if (!row) throw AppException.notFound('Чек не найден');
    if (!row.file_id) throw AppException.validation('У чека нет фото — заполните поля вручную');
    const fail = async (error: string) => {
      await this.repo.updateReceipt(me.tenantId, me.userId, id, { status: 'failed', error });
      return this.receiptView(await this.repo.receipt(me.tenantId, me.userId, id));
    };
    if (!(await this.ai.hasModel(me.tenantId))) return fail('Распознавание работает с подключённым ключом ИИ — заполните поля вручную');
    if (await this.ai.limitExhausted(me.tenantId)) return fail('Лимит ИИ на этот месяц исчерпан — заполните поля вручную');
    const mime = String(row.content_type ?? '');
    const buf = await this.fileBuffer(me.tenantId, String(row.file_id));
    const { date: today } = localParts(new Date(), await this.proactiveRepo.timezoneOf(me.tenantId, me.userId));
    let raw = '';
    try {
      if (mime.startsWith('image/')) {
        if (buf.length > 8 * 1024 * 1024) return fail('Фото больше 8 МБ — сфотографируйте чек ближе или сожмите');
        raw = await this.ai.generate(me.tenantId, RECEIPT_SYSTEM, 'Распознай чек на изображении.', 'receipt_ocr', {
          maxTokens: 400, timeoutMs: 60_000, images: [{ mime: mime === 'image/jpg' ? 'image/jpeg' : mime, base64: buf.toString('base64') }],
        });
      } else {
        const got = await extractText(buf, row.file_name ?? 'чек', mime);
        if (!got?.text?.trim()) return fail('В файле нет текста — загрузите фото чека');
        raw = await this.ai.generate(me.tenantId, RECEIPT_SYSTEM, `Текст чека:\n${got.text.slice(0, 8000)}`, 'receipt_ocr', { maxTokens: 400, timeoutMs: 60_000 });
      }
    } catch (e) {
      return fail(`Модель не ответила: ${(e as Error).message}`.slice(0, 300));
    }
    const f = parseReceiptAi(raw, today);
    if (!f) return fail('Не нашли на фото итоговую сумму — проверьте снимок или заполните вручную');
    await this.repo.updateReceipt(me.tenantId, me.userId, id, {
      status: 'recognized', error: null, spentOn: f.spentOn, seller: f.seller, sellerInn: f.sellerInn, total: f.total, vat: f.vat,
      currency: f.currency, category: f.category,
    });
    return this.receiptView(await this.repo.receipt(me.tenantId, me.userId, id));
  }

  async updateReceipt(me: Me, id: string, dto: any) {
    const v: Record<string, unknown> = {};
    const s = (x: unknown, n: number) => (x === null || x === '' ? null : String(x).trim().slice(0, n));
    const money = (x: unknown) => {
      if (x === null || x === '') return null;
      const n = Number(String(x).replace(/\s/g, '').replace(',', '.'));
      if (!Number.isFinite(n) || n < 0 || n > 1e11) throw AppException.validation('Сумма — числом');
      return Math.round(n * 100) / 100;
    };
    if (dto.spentOn !== undefined) {
      if (dto.spentOn && !/^\d{4}-\d{2}-\d{2}$/.test(String(dto.spentOn))) throw AppException.validation('Дата — ГГГГ-ММ-ДД');
      v.spentOn = dto.spentOn || null;
    }
    if (dto.seller !== undefined) v.seller = s(dto.seller, 200);
    if (dto.sellerInn !== undefined) v.sellerInn = s(String(dto.sellerInn ?? '').replace(/\D/g, ''), 16);
    if (dto.total !== undefined) v.total = money(dto.total);
    if (dto.vat !== undefined) v.vat = money(dto.vat);
    if (dto.currency !== undefined) v.currency = /^[A-Za-z]{3}$/.test(String(dto.currency)) ? String(dto.currency).toUpperCase() : 'RUB';
    if (dto.category !== undefined) v.category = (RECEIPT_CATEGORIES as readonly string[]).includes(dto.category) ? dto.category : 'other';
    if (dto.purpose !== undefined) v.purpose = s(dto.purpose, 300);
    const cur = await this.repo.receipt(me.tenantId, me.userId, id);
    if (!cur) throw AppException.notFound('Чек не найден');
    // правка руками после неудачного распознавания — чек уже «заполнен вручную»
    if (cur.status === 'failed' || cur.status === 'new') { v.status = 'manual'; v.error = null; }
    await this.repo.updateReceipt(me.tenantId, me.userId, id, v as any);
    return this.receiptView(await this.repo.receipt(me.tenantId, me.userId, id));
  }

  async removeReceipt(me: Me, id: string) {
    const r = await this.repo.removeReceipt(me.tenantId, me.userId, id);
    if (!r) throw AppException.notFound('Чек не найден');
    if (r.file_id) await this.files.removeInternal(me.tenantId, String(r.file_id)).catch(() => undefined);
    return { removed: true };
  }

  async exportReceipts(me: Me, from: string | null, to: string | null): Promise<{ buffer: Buffer; fileName: string }> {
    const rows = await this.repo.receipts(me.tenantId, me.userId, from, to);
    const person = (await this.repo.userName(me.tenantId, me.userId))?.full_name ?? '';
    const table = advanceReportRows(rows.filter((r) => r.total !== null), { person, from, to });
    const buffer = await xlsxFrom(table, 'Авансовый отчёт');
    const tag = [from, to].filter(Boolean).join('_') || new Date().toISOString().slice(0, 10);
    return { buffer, fileName: `avansovyj-otchet-${tag}.xlsx` };
  }
}
