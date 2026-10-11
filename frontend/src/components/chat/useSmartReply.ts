import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';

export interface SmartReplyState {
  /** серый текст для пустого поля; null — показывать нечего */
  text: string | null;
  reasonText: string | null;
  loading: boolean;
  /** ответ ждут, но черновика нет: нет модели, лимит, выключено */
  unavailable: string | null;
}

/**
 * Готовый ответ (ТЗ-21, этап 5). Спрашиваем сервер, когда открыли чат или пришло новое
 * сообщение; он сам решает, ждут ли ответа от этого человека, и держит черновик до
 * следующего сообщения. Отправляет всегда человек — здесь только текст для поля.
 */
export function useSmartReply(chatId: string | null, lastMessageId: string | null, enabled: boolean) {
  const [state, setState] = useState<SmartReplyState>({ text: null, reasonText: null, loading: false, unavailable: null });
  const meta = useRef<{ lastMessageId: string | null; variant: number; accepted: string | null; hidden: boolean }>({
    lastMessageId: null, variant: 0, accepted: null, hidden: false,
  });

  const load = useCallback(async (variant: number) => {
    if (!chatId) return;
    setState((s) => ({ ...s, loading: true }));
    try {
      const r = await api.smartReply(chatId, variant);
      meta.current = { lastMessageId: r.lastMessageId ?? null, variant, accepted: null, hidden: false };
      setState({
        text: r.needed && r.text ? r.text : null, reasonText: r.reasonText ?? null, loading: false,
        unavailable: r.needed && !r.text ? r.unavailable ?? null : null,
      });
    } catch {
      setState({ text: null, reasonText: null, loading: false, unavailable: null });
    }
  }, [chatId]);

  // новое сообщение или другой чат — черновик пересчитывается (с паузой: сообщения идут пачкой)
  useEffect(() => {
    setState({ text: null, reasonText: null, loading: false, unavailable: null });
    if (!enabled || !chatId || !lastMessageId) return;
    const t = setTimeout(() => { void load(0); }, 700);
    return () => clearTimeout(t);
  }, [chatId, lastMessageId, enabled, load]);

  const report = (outcome: 'accepted' | 'edited' | 'dismissed') => {
    const m = meta.current;
    if (!chatId || !m.lastMessageId) return;
    void api.smartReplyOutcome(chatId, m.lastMessageId, m.variant, outcome).catch(() => undefined);
  };

  return {
    ...state,
    /** Tab: текст ушёл в поле — запомним, чтобы при отправке понять, правили ли его */
    accept: () => { meta.current.accepted = state.text; report('accepted'); setState((s) => ({ ...s, text: null })); },
    /** Esc: скрыть до следующего сообщения */
    dismiss: () => { meta.current.hidden = true; report('dismissed'); setState((s) => ({ ...s, text: null })); },
    /** ✨: другой вариант (короче / подробнее) */
    another: () => { void load((meta.current.variant + 1) % 3); },
    /** отправили сообщение: если брали черновик и поменяли — «поправил» */
    sent: (text: string) => {
      const a = meta.current.accepted;
      if (a && text.trim() !== a.trim()) report('edited');
      meta.current.accepted = null;
    },
  };
}
