/**
 * Набор иконок QEVO — на Lucide (ТЗ-15).
 *
 * Имена остались прежними: смысл каждой иконки закреплён за её именем, и сотни мест
 * в интерфейсе о замене рисунка не знают. Сменился только стиль — единый набор
 * Lucide (тот же, что у shadcn/ui): сетка 24, линия 1.75, скруглённые концы, цвет
 * из currentColor. Каждая иконка импортируется поштучно — в сборку попадают только
 * эти ~80, а не вся библиотека.
 */
import type { LucideIcon } from 'lucide-react';
import {
  MessageSquare, Hash, Smile, Phone, PhoneOff, Volume2, Video, VideoOff, Mic, MicOff, ScreenShare,
  CircleDot, Square, Hand, Bot, Users, User, UserPlus, Maximize2, Minimize2, PictureInPicture2,
  SquareKanban, List, Check, CircleCheck, X, Plus, Minus, Search, Settings, ListFilter, ArrowUpDown,
  MoreHorizontal, Folder, Archive, File, Paperclip, Download, Upload, Image, Calendar, Clock, Bell,
  Flag, Star, Tag, Pencil, Trash2, Copy, Link, RefreshCw, Send, ChevronLeft, ChevronRight,
  ChevronDown, ChevronUp, ArrowLeft, ArrowRight, ArrowUp, ArrowDown, Reply, LifeBuoy, TriangleAlert,
  Info, CircleHelp, Lock, Eye, EyeOff, LogOut, BookOpen, Inbox, Plug, Handshake, Sparkles,
  ChartColumn, Wallet, Sun, Moon, Monitor, Play, Pause, Mail, Building2, Target, Zap,
} from 'lucide-react';

const ICONS = {
  chat: MessageSquare, hash: Hash, smile: Smile, phone: Phone, 'phone-off': PhoneOff, volume: Volume2,
  video: Video, 'video-off': VideoOff, mic: Mic, 'mic-off': MicOff, screen: ScreenShare,
  record: CircleDot, stop: Square, hand: Hand, robot: Bot, users: Users, user: User, 'user-plus': UserPlus,
  maximize: Maximize2, minimize: Minimize2, restore: PictureInPicture2,
  board: SquareKanban, list: List, check: Check, 'check-circle': CircleCheck, close: X, plus: Plus, minus: Minus,
  search: Search, settings: Settings, filter: ListFilter, sort: ArrowUpDown, more: MoreHorizontal,
  folder: Folder, archive: Archive, file: File, paperclip: Paperclip, download: Download, upload: Upload, image: Image,
  calendar: Calendar, clock: Clock, bell: Bell, flag: Flag, star: Star, tag: Tag,
  edit: Pencil, trash: Trash2, copy: Copy, link: Link, refresh: RefreshCw, send: Send,
  'chevron-left': ChevronLeft, 'chevron-right': ChevronRight, 'chevron-down': ChevronDown, 'chevron-up': ChevronUp,
  'arrow-left': ArrowLeft, 'arrow-right': ArrowRight, 'arrow-up': ArrowUp, 'arrow-down': ArrowDown,
  reply: Reply, support: LifeBuoy,
  alert: TriangleAlert, info: Info, help: CircleHelp, lock: Lock, eye: Eye, 'eye-off': EyeOff, logout: LogOut,
  book: BookOpen, inbox: Inbox, plug: Plug, handshake: Handshake, sparkles: Sparkles, chart: ChartColumn,
  money: Wallet, sun: Sun, moon: Moon, monitor: Monitor,
  play: Play, pause: Pause, mail: Mail, building: Building2, target: Target, zap: Zap,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

/**
 * @param size пиксели; 16 — в строке текста, 18 — в кнопках, 20+ — в заголовках
 */
export function Icon({ name, size = 16, className, title }: {
  name: IconName;
  size?: number;
  className?: string;
  title?: string;
}) {
  const Svg = ICONS[name];
  return (
    <Svg
      className={`icon ${className ?? ''}`}
      size={size}
      strokeWidth={1.75}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      role={title ? 'img' : undefined}
      focusable="false"
    />
  );
}
