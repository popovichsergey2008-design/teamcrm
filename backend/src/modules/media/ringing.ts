/**
 * Кому прямо сейчас звонят из комнаты.
 *
 * Нужно ровно для одного случая: звонящий передумал и вышел, а у вызываемого окно
 * вызова продолжает висеть — сервер об отмене никому не сообщал. Держать это в самой
 * комнате нельзя: комната закрывается ПЕРВОЙ, а гасить звонок надо уже после неё.
 *
 * Учёт по комнате, а не по звонящему: звать могут несколько человек по очереди,
 * а окно у вызываемого одно — и относится оно к встрече.
 */
export class Ringing {
  private readonly byRoom = new Map<string, Set<string>>();

  /** Позвали: с этой секунды у человека звонит телефон. */
  add(roomId: string, userId: string): void {
    const set = this.byRoom.get(roomId) ?? new Set<string>();
    set.add(userId);
    this.byRoom.set(roomId, set);
  }

  /** Ответил, отклонил или вошёл сам — звонок больше не идёт. */
  stop(roomId: string, userId: string): void {
    const set = this.byRoom.get(roomId);
    if (!set) return;
    set.delete(userId);
    if (!set.size) this.byRoom.delete(roomId);
  }

  /** Комната закрылась: возвращаем тех, у кого звонок так и висит, и забываем её. */
  clear(roomId: string): string[] {
    const set = this.byRoom.get(roomId);
    this.byRoom.delete(roomId);
    return set ? [...set] : [];
  }

  /** Кому звонит сейчас (для диагностики и тестов). */
  waiting(roomId: string): string[] {
    return [...(this.byRoom.get(roomId) ?? [])];
  }

  /**
   * В какие комнаты зовут этого человека — для телефона, который открылся по push
   * (ТЗ-9): пока он подключался, звонок уже шёл, и его надо показать заново.
   */
  roomsFor(userId: string): string[] {
    const out: string[] = [];
    for (const [roomId, set] of this.byRoom) if (set.has(userId)) out.push(roomId);
    return out;
  }
}
