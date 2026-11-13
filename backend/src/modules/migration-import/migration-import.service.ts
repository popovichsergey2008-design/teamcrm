import { Injectable, Logger } from '@nestjs/common';
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import JSZip from 'jszip';
import { trackBackground } from '../../common/background-work';
import { AppException } from '../../common/http/app-exception';
import { S3Service } from '../files/s3.client';
import { FilesService } from '../files/files.service';
import { validateUpload } from '../files/files.validation';
import { ProjectsRepository } from '../projects/projects.repository';
import { InvitesService } from '../team/invites.service';
import { openArchive } from './archive';
import { inviteList, matchPeople, messageKey, outsiderName, splitBatches } from './import-plan';
import { ImportBundle, ImportChat, ImportFile, ImportSource, summarize, ScanSummary } from './import-types';
import { JobRow, MessageInsert, MigrationImportRepository } from './migration-import.repository';

/** Что выбрал человек перед переносом. */
export interface StartOptions {
  /** Ключи чатов из сводки; пусто — то, что отмечено по умолчанию. */
  chatKeys?: string[];
  /** Позвать в команду тех, кого нет (по почте из Slack). */
  invite?: boolean;
  /** Открытые каналы Slack → проекты (найти по имени или завести). */
  projects?: boolean;
}

export interface ImportReport {
  chats: number;
  chatsCreated: number;
  projectsCreated: string[];
  messages: number;
  duplicates: number;
  files: number;
  filesFailed: number;
  usersMatched: number;
  outsiders: number;
  invited: number;
  invitedEmails: string[];
  relinked: number;
  skippedService: number;
  failed: { what: string; reason: string }[];
  failedTotal: number;
  chatList: { title: string; chatId: string; messages: number }[];
  durationMs: number;
}

/** Через сколько минут без «пульса» задание считается прерванным. */
const STALE_MIN = 10;
/** Сколько файлов качаем одновременно: Slack режет частые запросы, а память не резиновая. */
const FILE_POOL = 4;
const FILE_TIMEOUT_MS = 60_000;
/** Подробностей «не удалось» в отчёте — столько; остальное считаем числом. */
const FAILED_SHOWN = 200;
const BODY_MAX = 20_000;
/** Больше не примет и хранилище (видео — 400 МБ); качать такое в память незачем. */
const MAX_FILE_DOWNLOAD = 400 * 1024 * 1024;

/** Откуда разрешено качать файлы Slack: только сам Slack, а не любой адрес из архива. */
export function isSlackFileHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase();
    return h === 'files.slack.com' || h.endsWith('.slack.com') || h === 'slack-files.com' || h.endsWith('.slack-edge.com');
  } catch {
    return false;
  }
}

const EXT_MIME: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mp3: 'audio/mpeg', ogg: 'audio/ogg',
  oga: 'audio/ogg', m4a: 'audio/x-m4a', wav: 'audio/wav', pdf: 'application/pdf', txt: 'text/plain',
  csv: 'text/csv', zip: 'application/zip', doc: 'application/msword', xls: 'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

/** Тип файла, который примет хранилище: незнакомый — «просто файл», отдаётся вложением. */
export function storableMime(mime: string | null, name: string): string {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  const guess = mime || EXT_MIME[ext] || 'application/octet-stream';
  return validateUpload(guess, 1, Number.MAX_SAFE_INTEGER).ok ? guess : 'application/octet-stream';
}

/**
 * Переезд из Slack и Telegram (#4902, п. 4).
 *
 * Путь человека: архив → мы показали, что в нём (каналы, люди, сколько сообщений) →
 * он отметил нужное → перенос в фоне с полоской хода → отчёт «перенесено / не удалось».
 *
 * Архив между шагами лежит в хранилище файлов, состояние — в базе: процессов API
 * несколько, и «Перенести» может прийти в соседний. Перенос идёт пачками по 500
 * сообщений одним запросом — 10 000 сообщений занимают секунды, время уходит только
 * на скачивание файлов. Повтор того же архива безопасен: ключ у каждого сообщения
 * уникален, перенесённое второй раз не вставляется.
 */
@Injectable()
export class MigrationImportService {
  private readonly log = new Logger('MigrationImport');

  constructor(
    private readonly repo: MigrationImportRepository,
    private readonly s3: S3Service,
    private readonly files: FilesService,
    private readonly projects: ProjectsRepository,
    private readonly invites: InvitesService,
  ) {}

  // ── шаг 1: загрузка и разбор ──

  async upload(tenantId: string, userId: string, source: ImportSource, file: { path: string; originalname: string; size: number }) {
    const job = await this.repo.createJob({ tenantId, userId, source, fileName: file.originalname || 'архив', size: file.size });
    // Разбор — в фоне: ответ на загрузку уходит сразу, полоска хода не висит на
    // одном долгом запросе (nginx оборвал бы его по таймауту)
    void trackBackground(this.scan(job, file.path)).catch(() => undefined);
    return this.view(job);
  }

  private async scan(job: JobRow, tmpPath: string): Promise<void> {
    try {
      const buf = await fs.readFile(tmpPath);
      const { bundle } = await openArchive(job.source, buf);
      const summary = summarize(bundle);
      if (!summary.chats.length) throw new Error('В архиве не нашлось переписки, которую можно перенести');
      const key = `imports/${job.tenant_id}/${job.id}-${randomUUID()}${buf.length && buf[0] === 0x50 ? '.zip' : '.json'}`;
      await this.s3.client.send(new PutObjectCommand({
        Bucket: this.s3.bucket, Key: key, Body: buf, ContentLength: buf.length, ContentType: 'application/octet-stream',
      }));
      await this.repo.scanned(job.id, key, summary);
    } catch (e) {
      this.log.warn(`разбор архива ${job.id}: ${(e as Error).message}`);
      await this.repo.failScan(job.id, (e as Error).message || 'Архив не читается');
    } finally {
      // чужая переписка не должна оставаться во временной папке сервера
      await fs.unlink(tmpPath).catch(() => undefined);
    }
  }

  // ── шаг 2: перенос ──

  async start(tenantId: string, userId: string, id: string, options: StartOptions) {
    await this.repo.expireStale(tenantId, STALE_MIN);
    const job = await this.repo.job(tenantId, id);
    if (!job) throw AppException.notFound('Загрузка не найдена');
    if (job.status === 'running') throw AppException.conflict('Перенос уже идёт');
    if (job.status !== 'ready' || !job.object_key) throw AppException.validation('Архив больше недоступен — загрузите его заново');
    const scan = job.scan as ScanSummary;
    const known = new Set(scan.chats.map((c) => c.key));
    const chatKeys = (options.chatKeys ?? []).filter((k) => known.has(k));
    if (options.chatKeys && !chatKeys.length) throw AppException.validation('Отметьте хотя бы один чат');
    const opts: StartOptions = {
      chatKeys: chatKeys.length ? chatKeys : scan.chats.filter((c) => c.selected).map((c) => c.key),
      invite: options.invite !== false,
      projects: options.projects !== false,
    };
    const claimed = await this.repo.claim(tenantId, id, opts);
    if (!claimed) throw AppException.conflict('Перенос уже запущен');
    void trackBackground(this.run(claimed, userId, opts)).catch(() => undefined);
    return this.view(claimed);
  }

  async get(tenantId: string, id: string) {
    await this.repo.expireStale(tenantId, STALE_MIN);
    const job = await this.repo.job(tenantId, id);
    if (!job) throw AppException.notFound('Загрузка не найдена');
    return this.view(job);
  }

  async list(tenantId: string) {
    await this.repo.expireStale(tenantId, STALE_MIN);
    return (await this.repo.jobs(tenantId)).map((j) => this.view(j));
  }

  private view(j: JobRow) {
    return {
      id: String(j.id),
      source: j.source,
      fileName: j.file_name,
      sizeBytes: Number(j.size_bytes),
      status: j.status,
      scan: j.scan ?? null,
      options: j.options ?? null,
      progress: j.progress ?? null,
      report: j.report ?? null,
      error: j.error,
      createdAt: j.created_at,
      startedAt: j.started_at,
      finishedAt: j.finished_at,
    };
  }

  /** Перенос целиком. Любая ошибка — в отчёт; архив остаётся, чтобы можно было повторить. */
  private async run(job: JobRow, userId: string, opts: StartOptions): Promise<void> {
    const startedAt = Date.now();
    const report: ImportReport = {
      chats: 0, chatsCreated: 0, projectsCreated: [], messages: 0, duplicates: 0, files: 0, filesFailed: 0,
      usersMatched: 0, outsiders: 0, invited: 0, invitedEmails: [], relinked: 0, skippedService: 0,
      failed: [], failedTotal: 0, chatList: [], durationMs: 0,
    };
    const tenantId = String(job.tenant_id);
    try {
      await this.repo.progress(job.id, { stage: 'read' });
      const obj = await this.s3.client.send(new GetObjectCommand({ Bucket: this.s3.bucket, Key: job.object_key! }));
      const buf = Buffer.from(await (obj.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
      const { bundle, zip } = await openArchive(job.source, buf);
      await this.transfer(tenantId, userId, job.id, bundle, zip, opts, report);
      report.durationMs = Date.now() - startedAt;
      await this.repo.finish(job.id, 'done', report, null, false);
      await this.s3.client.send(new DeleteObjectCommand({ Bucket: this.s3.bucket, Key: job.object_key! })).catch(() => undefined);
      this.log.log(`перенос ${job.source} ${job.id}: чатов ${report.chats}, сообщений ${report.messages}, файлов ${report.files}, за ${report.durationMs} мс`);
    } catch (e) {
      report.durationMs = Date.now() - startedAt;
      this.log.warn(`перенос ${job.id} упал: ${(e as Error).stack ?? e}`);
      // статус «готов к запуску», а не «провал»: архив цел, повтор продолжит без дублей
      await this.repo.finish(job.id, 'ready', report, `Перенос остановился: ${(e as Error).message}. Запустите ещё раз — уже перенесённое не задвоится`, true);
    }
  }

  private fail(report: ImportReport, what: string, reason: string) {
    report.failedTotal++;
    if (report.failed.length < FAILED_SHOWN) report.failed.push({ what, reason });
  }

  /** Сам перенос: люди → приглашения → чаты → файлы → сообщения. */
  async transfer(
    tenantId: string, userId: string, jobId: string, bundle: ImportBundle, zip: JSZip | null,
    opts: StartOptions, report: ImportReport,
  ): Promise<void> {
    const wanted = new Set(opts.chatKeys ?? []);
    const chats = bundle.chats.filter((c) => wanted.has(c.ext));
    report.skippedService = bundle.skippedService;

    // Люди
    const matched = matchPeople(bundle.people, await this.repo.teamUsers(tenantId));
    const involved = new Set<string>();
    for (const c of chats) {
      for (const id of c.memberExts) involved.add(id);
      for (const m of c.messages) if (m.authorExt) involved.add(m.authorExt);
    }
    const humans = bundle.people.filter((p) => !p.isBot && involved.has(p.ext));
    report.usersMatched = humans.filter((p) => matched.has(p.ext)).length;
    report.outsiders = humans.length - report.usersMatched;

    // Приглашения: у Slack есть почты, у Telegram их нет — там только подпись именем
    if (opts.invite && bundle.source === 'slack') {
      const emails = inviteList(bundle.people, matched, involved, await this.repo.pendingInviteEmails(tenantId));
      if (emails.length) {
        await this.repo.progress(jobId, { stage: 'invite', total: emails.length });
        const res = await this.invites.inviteMany(tenantId, userId, { emails, role: 'member' });
        for (const r of res.results) {
          if (r.ok) { report.invited++; report.invitedEmails.push(r.email); } else this.fail(report, `Приглашение ${r.email}`, r.error ?? 'не отправлено');
        }
      }
    }

    const chatRefs = await this.repo.refs(tenantId, bundle.sourceKey, 'chat');
    const fileRefs = await this.repo.refs(tenantId, bundle.sourceKey, 'file');
    const total = chats.reduce((n, c) => n + c.messages.length, 0);
    let done = 0;
    let lastBeat = 0;
    const beat = async (stage: string, chat: string, force = false) => {
      if (!force && Date.now() - lastBeat < 1000) return;
      lastBeat = Date.now();
      await this.repo.progress(jobId, { stage, chat, done, total, files: report.files, chatsDone: report.chats, chatsTotal: chats.length });
    };

    const touched: string[] = [];
    for (const chat of chats) {
      await beat('chat', chat.title, true);
      const chatId = await this.ensureChat(tenantId, userId, bundle, chat, matched, chatRefs, opts, report);
      if (!chatId) { done += chat.messages.length; continue; }
      touched.push(chatId);

      // Файлы — до сообщений: сообщение вставляется сразу со своими вложениями
      const fileIds = await this.transferFiles(tenantId, userId, bundle, chat, chatId, zip, fileRefs, report, () => beat('files', chat.title));

      const before = report.messages;
      const ids = new Map<string, string>();
      for (const batch of splitBatches(chat.messages)) {
        const rows: MessageInsert[] = [];
        const filesOf = new Map<string, string[]>();
        for (const m of batch) {
          const key = messageKey(bundle.sourceKey, chat.ext, m.ext);
          const authorId = m.authorExt ? matched.get(m.authorExt) ?? null : null;
          const got = m.files.map((f) => fileIds.get(this.fileRefKey(chat, f))).filter((v): v is string => !!v);
          const lost = m.files.filter((f) => !fileIds.has(this.fileRefKey(chat, f)));
          let body = m.body;
          // не перенёсся файл — пусть в переписке останется след, иначе «смотри вложение» повиснет в воздухе
          for (const f of lost) body = `${body}${body ? '\n' : ''}[Файл «${f.name}» не перенесён]`;
          rows.push({
            authorId,
            guestName: authorId ? null : outsiderName(m.authorName, bundle.source),
            body: body.slice(0, BODY_MAX),
            fileId: got[0] ?? null,
            at: new Date(Number.isFinite(m.at) ? m.at : Date.now()).toISOString(),
            threadRootId: m.threadExt ? ids.get(messageKey(bundle.sourceKey, chat.ext, m.threadExt)) ?? null : null,
            alsoInChannel: !!m.broadcast,
            replyToId: m.replyToExt ? ids.get(messageKey(bundle.sourceKey, chat.ext, m.replyToExt)) ?? null : null,
            key,
            importAuthor: m.authorExt ? m.authorExt.slice(0, 64) : null,
          });
          if (got.length) filesOf.set(key, got);
        }
        const inserted = await this.repo.insertMessages(tenantId, chatId, rows);
        for (const r of inserted) ids.set(r.import_key, r.id);
        // повтор импорта: уже перенесённые не вставились — берём их id для веток и цитат
        const missing = rows.map((r) => r.key).filter((k) => !ids.has(k));
        if (missing.length) for (const [k, v] of await this.repo.idsByKeys(tenantId, missing)) ids.set(k, v);
        await this.repo.insertMessageFiles(tenantId, inserted.flatMap((r) =>
          (filesOf.get(r.import_key) ?? []).map((fileId, position) => ({ messageId: r.id, fileId, position }))));
        report.messages += inserted.length;
        report.duplicates += rows.length - inserted.length;
        done += batch.length;
        await beat('messages', chat.title);
      }
      await this.repo.finalizeChat(tenantId, chatId);
      report.chats++;
      report.chatList.push({ title: chat.title, chatId, messages: report.messages - before });
    }

    // Пришедшие в команду после прошлого импорта — подписываем их сообщения ими
    const pairs = [...matched.entries()].map(([ext, uid]) => ({ ext, userId: uid }));
    report.relinked = await this.repo.relinkAuthors(tenantId, touched, pairs);
    await beat('done', '', true);
  }

  /** Ключ файла в справочнике переноса: id файла в своём чате (в Telegram id не глобальны). */
  private fileRefKey(chat: ImportChat, f: ImportFile): string {
    return `${chat.ext}|${f.ext}`.slice(0, 255);
  }

  /**
   * Наш чат для чата старой системы: уже перенесённый (по справочнику) или новый.
   * null — чат перенести нельзя, причина уже в отчёте.
   */
  private async ensureChat(
    tenantId: string, userId: string, bundle: ImportBundle, chat: ImportChat, matched: Map<string, string>,
    refs: Map<string, string>, opts: StartOptions, report: ImportReport,
  ): Promise<string | null> {
    const local = (exts: string[]) => [...new Set(exts.map((e) => matched.get(e)).filter((v): v is string => !!v))];
    const authors = chat.messages.map((m) => m.authorExt).filter((v): v is string => !!v);
    const prefix = `${bundle.sourceKey}:${chat.ext}:`;
    const label = chat.kind === 'dm' || chat.kind === 'mpim' ? `Переписка «${chat.title}»` : `Чат «${chat.title}»`;

    // участники, кого видно по данным старой системы
    let members: string[];
    switch (chat.kind) {
      case 'channel': case 'tg_group': case 'tg_channel': case 'tg_personal':
        members = [userId, ...local([...chat.memberExts, ...authors])];
        break;
      default: // закрытые и личные — строго по списку участников, без «на всякий случай»
        members = local(chat.memberExts.length ? chat.memberExts : authors);
    }
    const withRoles = (ids: string[]) => [...new Set(ids)].map((id, i) => ({ userId: id, role: (i === 0 ? 'owner' : 'member') as 'owner' | 'member' }));

    const known = refs.get(chat.ext);
    if (known && await this.repo.chatAlive(tenantId, known)) {
      await this.repo.addMembers(tenantId, known, withRoles(members).map((m) => ({ ...m, role: 'member' as const })));
      return known;
    }

    let chatId: string;
    switch (chat.kind) {
      case 'channel': {
        if (opts.projects) {
          let project = await this.repo.findProject(tenantId, chat.title);
          if (!project) {
            project = { id: String((await this.projects.create({ tenantId, name: chat.title.slice(0, 120), description: chat.description ?? '' })).id) };
            report.projectsCreated.push(chat.title);
          }
          const own = await this.repo.projectChat(project.id);
          // Чат проекта берём, только если он пуст: лента идёт по порядку вставки, и
          // старая история, подмешанная к живой переписке, встала бы ПОСЛЕ неё
          if (!own || (await this.repo.foreignMessages(tenantId, own.id, prefix)) === 0) {
            chatId = own?.id ?? await this.repo.ensureProjectChat(tenantId, project.id, userId);
          } else {
            chatId = await this.repo.createChat({
              tenantId, kind: 'channel', title: `${chat.title} (из Slack)`, description: chat.description ?? null,
              isPrivate: false, linkedProjectId: project.id, createdBy: userId,
            });
            report.chatsCreated++;
          }
        } else {
          chatId = await this.repo.createChat({
            tenantId, kind: 'channel', title: chat.title, description: chat.description ?? null,
            isPrivate: false, linkedProjectId: null, createdBy: userId,
          });
          report.chatsCreated++;
        }
        break;
      }
      case 'private': {
        // закрытый канал остаётся закрытым: проект виден всей команде, и его имя
        // уже рассказало бы лишнее. Никого из участников нет — отдаём тому, кто переносит
        if (!members.length) members = [userId];
        chatId = await this.repo.createChat({
          tenantId, kind: 'channel', title: chat.title, description: chat.description ?? null,
          isPrivate: true, linkedProjectId: null, createdBy: userId,
        });
        report.chatsCreated++;
        break;
      }
      case 'dm': {
        if (members.length < 2) {
          this.fail(report, label, 'собеседников нет в команде — личную переписку переносим, только когда оба уже в QEVO (повторите импорт после принятия приглашений)');
          return null;
        }
        const key = members.map(Number).sort((a, b) => a - b).slice(0, 2).join(':');
        const dm = await this.repo.findDm(tenantId, key);
        if (!dm) {
          chatId = await this.repo.createChat({ tenantId, kind: 'dm', title: null, description: null, isPrivate: true, linkedProjectId: null, createdBy: members[0], dmKey: key });
          report.chatsCreated++;
        } else if ((await this.repo.foreignMessages(tenantId, dm.id, prefix)) === 0) {
          chatId = dm.id;
        } else {
          // у них уже есть живой диалог — историю кладём рядом, а не в его конец
          chatId = await this.repo.createChat({ tenantId, kind: 'group', title: `${chat.title} (из Slack)`, description: null, isPrivate: true, linkedProjectId: null, createdBy: members[0] });
          report.chatsCreated++;
        }
        break;
      }
      case 'mpim': {
        if (members.length < 2) {
          this.fail(report, label, 'в команде меньше двух участников этой переписки — перенесём повторным импортом, когда они примут приглашения');
          return null;
        }
        chatId = await this.repo.createChat({ tenantId, kind: 'group', title: chat.title, description: null, isPrivate: true, linkedProjectId: null, createdBy: members[0] });
        report.chatsCreated++;
        break;
      }
      default: {
        chatId = await this.repo.createChat({
          tenantId, kind: 'group', title: chat.title, description: 'Перенесено из Telegram', isPrivate: true, linkedProjectId: null, createdBy: userId,
        });
        report.chatsCreated++;
      }
    }
    await this.repo.addMembers(tenantId, chatId, withRoles(members));
    await this.repo.setRef(tenantId, bundle.sourceKey, 'chat', chat.ext, chatId);
    refs.set(chat.ext, chatId);
    return chatId;
  }

  /** Файлы чата → наше хранилище. Уже перенесённые не качаем повторно. */
  private async transferFiles(
    tenantId: string, userId: string, bundle: ImportBundle, chat: ImportChat, chatId: string, zip: JSZip | null,
    refs: Map<string, string>, report: ImportReport, beat: () => Promise<void>,
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    const queue: ImportFile[] = [];
    for (const m of chat.messages) {
      for (const f of m.files) {
        const key = this.fileRefKey(chat, f);
        const known = refs.get(key);
        if (known) { out.set(key, known); continue; }
        if (f.missing) { report.filesFailed++; this.fail(report, `Файл «${f.name}» (${chat.title})`, f.missing); continue; }
        queue.push(f);
      }
    }
    let next = 0;
    const worker = async () => {
      while (next < queue.length) {
        const f = queue[next++];
        const key = this.fileRefKey(chat, f);
        try {
          const buffer = bundle.source === 'slack' ? await this.downloadSlack(f) : await this.fromZip(zip, f);
          const row = await this.files.upload({
            tenantId, userId, buffer, fileName: f.name, contentType: storableMime(f.mime, f.name),
            ownerKind: 'chat_message', ownerId: chatId,
          });
          out.set(key, String(row.id));
          refs.set(key, String(row.id));
          await this.repo.setRef(tenantId, bundle.sourceKey, 'file', key, String(row.id));
          report.files++;
        } catch (e) {
          report.filesFailed++;
          this.fail(report, `Файл «${f.name}» (${chat.title})`, (e as Error).message || 'не скачался');
        }
        await beat();
      }
    };
    await Promise.all(Array.from({ length: Math.min(FILE_POOL, queue.length) }, worker));
    return out;
  }

  /**
   * Скачать файл Slack по ссылке из архива. Переадресации проходим сами и каждую
   * проверяем: ссылка из чужого архива не должна увести запрос сервера куда угодно
   * (во внутреннюю сеть, к хранилищу) — только к самому Slack.
   */
  private async downloadSlack(f: ImportFile): Promise<Buffer> {
    let url = f.url ?? '';
    for (let hop = 0; hop < 4; hop++) {
      if (!isSlackFileHost(url)) throw new Error('ссылка ведёт не на Slack — не качаем');
      const res = await fetch(url, { signal: AbortSignal.timeout(FILE_TIMEOUT_MS), redirect: 'manual' });
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).toString();
        continue;
      }
      if (!res.ok) throw new Error(`Slack ответил ${res.status} — токен в архиве мог истечь, сделайте свежий экспорт`);
      // вместо файла пришла страница входа: токен в ссылке уже недействителен
      if ((res.headers.get('content-type') ?? '').startsWith('text/html') && !/\.html?$/i.test(f.name)) {
        throw new Error('Slack вернул страницу входа вместо файла — токен в архиве истёк, сделайте свежий экспорт');
      }
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > MAX_FILE_DOWNLOAD) throw new Error('файл больше 400 МБ');
      return Buffer.from(await res.arrayBuffer());
    }
    throw new Error('слишком много переадресаций');
  }

  private async fromZip(zip: JSZip | null, f: ImportFile): Promise<Buffer> {
    const entry = f.zipPath && zip ? zip.file(f.zipPath) : null;
    if (!entry) throw new Error('файла нет в архиве');
    return entry.async('nodebuffer');
  }
}
