import { Injectable } from '@nestjs/common';
import { AppException } from '../../common/http/app-exception';
import { CalendarRepository, EventRow } from './calendar.repository';

const DEFAULT_WORK = { workStart: '09:00', workEnd: '18:00', weekendDays: [0, 6], holidays: [] as string[] };
const MAX_RANGE_DAYS = 62; // два месяца: больше одного экрана календаря не показывает

export interface EventDto {
  title: string;
  description?: string | null;
  location?: string | null;
  startsAt: string;
  endsAt: string;
  allDay?: boolean;
  color?: string | null;
  isPrivate?: boolean;
  scope?: 'personal' | 'company';
  participantIds?: string[];
  meetRoomId?: string | null;
}

@Injectable()
export class CalendarService {
  constructor(private readonly repo: CalendarRepository) {}

  /**
   * Всё, что нужно экрану за один запрос: события, задачи со сроком и рабочее время.
   *
   * Одним ответом, а не тремя запросами с фронта: при перелистывании недель три похода
   * в сеть на каждый щелчок — это заметная задержка там, где её быть не должно.
   */
  async range(tenantId: string, user: { userId: string; role: string }, from: string, to: string, withTasks: boolean) {
    const start = new Date(from);
    const end = new Date(to);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) {
      throw AppException.validation('Неверный промежуток дат');
    }
    if ((end.getTime() - start.getTime()) / 86_400_000 > MAX_RANGE_DAYS) {
      throw AppException.validation('Слишком большой промежуток');
    }

    const rows = await this.repo.eventsInRange(tenantId, user.userId, from, to);
    const participants = await this.repo.participantsFor(tenantId, rows.map((r) => r.id));
    const byEvent = new Map<string, typeof participants>();
    for (const p of participants) {
      const list = byEvent.get(String(p.event_id)) ?? [];
      list.push(p);
      byEvent.set(String(p.event_id), list);
    }

    const events = rows.map((r) => this.view(r, user.userId, byEvent.get(String(r.id)) ?? []));
    const tasks = withTasks ? await this.repo.tasksInRange(tenantId, user.userId, from, to) : [];
    return { events, tasks, work: await this.work(tenantId) };
  }

  async work(tenantId: string) {
    const s = await this.repo.workSettings(tenantId);
    if (!s) return DEFAULT_WORK;
    return {
      workStart: s.work_start.slice(0, 5),
      workEnd: s.work_end.slice(0, 5),
      weekendDays: s.weekend_days ?? [0, 6],
      holidays: (s.holidays ?? []).map((d) => (typeof d === 'string' ? d : d.toISOString().slice(0, 10))),
    };
  }

  /** Рабочее время задаёт владелец (их может быть несколько — это и есть «помощник владельца»). */
  async saveWork(tenantId: string, user: { userId: string; role: string }, dto: {
    workStart: string; workEnd: string; weekendDays: number[]; holidays: string[];
  }) {
    if (user.role !== 'owner') throw AppException.forbidden('Рабочее время задаёт владелец');
    if (dto.workStart >= dto.workEnd) throw AppException.validation('Начало рабочего дня должно быть раньше конца');
    await this.repo.saveWorkSettings(tenantId, user.userId, {
      workStart: dto.workStart,
      workEnd: dto.workEnd,
      weekendDays: [...new Set(dto.weekendDays.filter((d) => d >= 0 && d <= 6))],
      holidays: [...new Set(dto.holidays)].slice(0, 200),
    });
    return this.work(tenantId);
  }

  pending(tenantId: string, userId: string) {
    return this.repo.pendingCount(tenantId, userId).then((count) => ({ count }));
  }

  async create(tenantId: string, user: { userId: string; role: string }, dto: EventDto) {
    const scope = dto.scope === 'company' ? 'company' : 'personal';
    // Общее событие компании касается всех — заводит его тот, кто отвечает за общее
    if (scope === 'company' && user.role !== 'owner' && user.role !== 'manager') {
      throw AppException.forbidden('Событие компании создаёт владелец или руководитель');
    }
    this.checkTime(dto);
    const row = await this.repo.create({
      tenantId,
      scope,
      ownerId: user.userId,
      title: dto.title.trim().slice(0, 255),
      description: dto.description?.trim() || null,
      location: dto.location?.trim()?.slice(0, 255) || null,
      meetRoomId: dto.meetRoomId?.trim() || null,
      startsAt: dto.startsAt,
      endsAt: dto.endsAt,
      allDay: !!dto.allDay,
      color: dto.color?.slice(0, 16) || null,
      isPrivate: !!dto.isPrivate,
      createdBy: user.userId,
      participantIds: dto.participantIds ?? [],
    });
    return this.details(tenantId, user, row.id);
  }

  async update(tenantId: string, user: { userId: string; role: string }, id: string, dto: Partial<EventDto>) {
    const event = await this.mine(tenantId, user, id);
    if (dto.startsAt && dto.endsAt) this.checkTime({ startsAt: dto.startsAt, endsAt: dto.endsAt } as EventDto);
    await this.repo.update(tenantId, id, {
      title: dto.title?.trim()?.slice(0, 255),
      description: dto.description === undefined ? undefined : (dto.description?.trim() || null),
      location: dto.location === undefined ? undefined : (dto.location?.trim()?.slice(0, 255) || null),
      meet_room_id: dto.meetRoomId === undefined ? undefined : (dto.meetRoomId || null),
      starts_at: dto.startsAt,
      ends_at: dto.endsAt,
      all_day: dto.allDay,
      color: dto.color === undefined ? undefined : (dto.color || null),
      is_private: dto.isPrivate,
    }, dto.participantIds, event.owner_id);
    return this.details(tenantId, user, id);
  }

  async remove(tenantId: string, user: { userId: string; role: string }, id: string) {
    await this.mine(tenantId, user, id);
    await this.repo.remove(tenantId, id);
    return { deleted: true };
  }

  /** Ответ на приглашение. Отвечать может только приглашённый — за других не решают. */
  async respond(tenantId: string, userId: string, id: string, status: 'accepted' | 'declined') {
    const ok = await this.repo.respond(tenantId, id, userId, status);
    if (!ok) throw AppException.notFound('Вас не приглашали на это событие');
    return { status };
  }

  async details(tenantId: string, user: { userId: string; role: string }, id: string) {
    const row = await this.repo.byId(tenantId, id);
    if (!row) throw AppException.notFound('Событие не найдено');
    const participants = await this.repo.participantsFor(tenantId, [id]);
    const visible = row.scope === 'company'
      || String(row.owner_id) === String(user.userId)
      || participants.some((p) => String(p.user_id) === String(user.userId));
    if (!visible) throw AppException.notFound('Событие не найдено');
    return this.view(row, user.userId, participants);
  }

  /** Правит событие организатор. Владелец правит и общие события компании — за них отвечает он. */
  private async mine(tenantId: string, user: { userId: string; role: string }, id: string): Promise<EventRow> {
    const row = await this.repo.byId(tenantId, id);
    if (!row) throw AppException.notFound('Событие не найдено');
    const isOwner = String(row.owner_id) === String(user.userId);
    const managesCompany = row.scope === 'company' && (user.role === 'owner' || user.role === 'manager');
    if (!isOwner && !managesCompany) throw AppException.forbidden('Событие меняет тот, кто его создал');
    return row;
  }

  private checkTime(dto: EventDto): void {
    const start = new Date(dto.startsAt);
    const end = new Date(dto.endsAt);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
      throw AppException.validation('Неверное время события');
    }
    if (end < start) throw AppException.validation('Событие не может закончиться раньше, чем начнётся');
  }

  /**
   * Что человек имеет право увидеть.
   *
   * Приватное чужое событие показывается как «Занято» без названия, описания и места:
   * коллеге нужно знать, что время занято, а не чем именно.
   */
  private view(row: EventRow & { my_status?: string | null }, userId: string, participants: { user_id: string; status: string; is_organizer: boolean; full_name: string | null; avatar_file_id: string | null }[]) {
    const mine = String(row.owner_id) === String(userId)
      || participants.some((p) => String(p.user_id) === String(userId));
    const hidden = row.is_private && !mine;
    return {
      id: row.id,
      scope: row.scope,
      title: hidden ? 'Занято' : row.title,
      description: hidden ? null : row.description,
      location: hidden ? null : row.location,
      meetRoomId: hidden ? null : row.meet_room_id,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      allDay: row.all_day,
      color: row.color,
      isPrivate: row.is_private,
      ownerId: row.owner_id,
      canEdit: String(row.owner_id) === String(userId),
      myStatus: row.my_status ?? (String(row.owner_id) === String(userId) ? 'accepted' : null),
      participants: hidden ? [] : participants.map((p) => ({
        userId: p.user_id,
        fullName: p.full_name,
        status: p.status,
        isOrganizer: p.is_organizer,
        avatarUrl: p.avatar_file_id ? `/api/files/${p.avatar_file_id}` : null,
      })),
    };
  }
}
