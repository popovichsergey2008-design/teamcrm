import { lazy, Suspense, useEffect, useState } from 'react';
import { useAuth } from '../../state/auth';

/**
 * Открыть службу заботы откуда угодно.
 *
 * Панель живёт в оболочке приложения, а звать её нужно из левого меню, из командной
 * строки и из пустых экранов («настроить вместе со специалистом»). Событие — самый
 * дешёвый способ: никому не приходится протаскивать через себя чужой обработчик.
 */
export const SUPPORT_OPEN = 'teamcrm:support-open';

/** Просьба открыть окно: обращение по номеру, готовый текст, голос или созвон (ТЗ-34). */
export interface SupportOpen { conversationId?: string; text?: string; voice?: boolean; call?: boolean; n?: number }

/**
 * Без номера — своя панель (написать в поддержку). С номером — ЭТО обращение:
 * так консоль техотдела открывает разговор, по которому щёлкнули в очереди.
 */
export function openSupport(conversationId?: string, opts?: Omit<SupportOpen, 'conversationId' | 'n'>): void {
  window.dispatchEvent(new CustomEvent<SupportOpen>(SUPPORT_OPEN, { detail: { conversationId, ...opts } }));
}

// Окно, островок, жесты и детектор заминок — ленивыми кусками: в стартовой сборке только этот файл.
const CareHub = lazy(() => import('./CareHub'));
const SupportPanel = lazy(() => import('./SupportPanel'));

/**
 * Служба заботы — панель поверх CRM (ТЗ-8) и Отдел заботы (ТЗ-34).
 *
 * Здесь только приёмник просьб «открыть»: сама панель, островок с временем ответа,
 * встряхивание и детектор заминок приезжают своим куском после первого экрана или
 * сразу, если человек позвал помощь раньше.
 */
export function SupportDock({ embedded = false }: { embedded?: boolean } = {}) {
  const { user } = useAuth();
  // ссылка /support/<номер> (push, «Продолжить на телефоне») — открыть разговор сразу
  const [req, setReq] = useState<SupportOpen | null>(() => (!embedded && /^\/support\/\d+/.test(window.location.pathname) ? { n: 1 } : null));
  const [ready, setReady] = useState(embedded || !!req);
  useEffect(() => {
    const on = (e: Event) => { setReq({ ...(e as CustomEvent<SupportOpen>).detail, n: Date.now() }); setReady(true); };
    window.addEventListener(SUPPORT_OPEN, on);
    const t = window.setTimeout(() => setReady(true), 1500);
    return () => { window.removeEventListener(SUPPORT_OPEN, on); window.clearTimeout(t); };
  }, []);
  if (!user || user.role === 'client' || !ready) return null;
  return <Suspense fallback={null}>{embedded ? <SupportPanel embedded request={req} /> : <CareHub request={req} />}</Suspense>;
}
