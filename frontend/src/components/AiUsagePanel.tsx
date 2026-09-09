import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { EmptyState } from './EmptyState';
import { SkeletonList } from './Skeleton';
import { api } from '../lib/api';
import { useEscape } from '../hooks/useEscape';
import { overlayProps } from '../lib/overlay';

interface FeatureRow {
  feature: string;
  title: string;
  where: string;
  group: string;
  calls: number;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  models: string[];
  mockCalls: number;
  lastAt: string | null;
}

interface Usage {
  periodDays: number;
  totalCalls: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  totalCost: number;
  mockCalls: number;
  cacheHitRatio: number;
  byFeature: FeatureRow[];
  byDay: { day: string; calls: number; tokens: number; cost: number; models: string[] }[];
}

const GROUPS: { key: string; title: string }[] = [
  { key: 'tasks', title: 'Задачи и поручения' },
  { key: 'meetings', title: 'Встречи и дейлики' },
  { key: 'knowledge', title: 'Знания и поиск' },
  { key: 'service', title: 'Служебное' },
];

/** «3 011 654» читается, «3011654» — нет. */
const num = (n: number) => n.toLocaleString('ru-RU');

/** Доллары с точностью, которая имеет смысл: центы у мелких сумм, целые у крупных. */
const money = (usd: number) => (usd >= 10 ? `$${usd.toFixed(0)}` : usd >= 0.01 ? `$${usd.toFixed(2)}` : usd > 0 ? '< $0.01' : '$0');

const dayLabel = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });

/**
 * Расход ИИ: сколько ушло, на что и когда.
 *
 * Экран отвечает на вопрос, который звучал так: «кажется, ИИ вызывается не везде».
 * Поэтому здесь не только израсходованные токены, но и полный список мест, где вызов
 * заложен, — с нулями напротив тех, что за период не сработали ни разу. Ноль в такой
 * таблице информативнее любого объяснения: сразу видно, что не запускали, а что
 * запускали и вхолостую.
 */
export function AiUsagePanel({ onClose }: { onClose: () => void }) {
  useEscape(onClose);
  const [days, setDays] = useState(30);
  const [data, setData] = useState<Usage | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.aiUsage(days)
      .then((d) => { if (alive) setData(d as Usage); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [days]);

  const peak = Math.max(1, ...(data?.byDay ?? []).map((d) => d.tokens));

  return (
    <div className="drawer-overlay" {...overlayProps(onClose)}>
      <aside className="drawer drawer-wide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3><Icon name="sparkles" size={18} /> Расход ИИ</h3>
          <button className="btn btn-ghost btn-sm" onClick={onClose} title="Закрыть"><Icon name="close" /></button>
        </div>

        <div className="ai-usage-period">
          {[7, 30, 90].map((d) => (
            <button
              key={d}
              className={`view-btn ${days === d ? 'active' : ''}`}
              onClick={() => setDays(d)}
            >
              {d} дней
            </button>
          ))}
        </div>

        {loading && <SkeletonList rows={5} />}

        {!loading && !data && (
          <EmptyState icon="alert" title="Не удалось получить расход" hint="Попробуйте открыть ещё раз." />
        )}

        {!loading && data && (
          <>
            <div className="ai-usage-sums">
              <div><div className="secretary-big">{num(data.totalTokens)}</div><div className="dim">токенов за период</div></div>
              <div><div className="secretary-big">{money(data.totalCost)}</div><div className="dim">примерная стоимость</div></div>
              <div><div className="secretary-big">{num(data.totalCalls)}</div><div className="dim">обращений к ИИ</div></div>
            </div>

            <div className="dim ai-usage-note">
              Входящих {num(data.inputTokens)} · исходящих {num(data.outputTokens)}
              {data.cacheHitRatio > 0 && ` · из кэша ${Math.round(data.cacheHitRatio * 100)}%`}
            </div>

            {/* Работа на заглушке — главное объяснение ощущения «ИИ не работает»:
                конвейер отрабатывает, но думает не модель. */}
            {data.mockCalls > 0 && (
              <div className="error-text ai-usage-mock">
                <Icon name="alert" size={13} /> {num(data.mockCalls)} обращений ушли в демо-режим:
                модель не отвечала, работал встроенный заменитель. Проверьте ключи в «Интеграции → ИИ».
              </div>
            )}

            <div className="drawer-section-title" style={{ marginTop: 14 }}>По дням</div>
            {data.byDay.length === 0 ? (
              <div className="dim">За этот период ИИ не вызывался ни разу.</div>
            ) : (
              <div className="ai-usage-days">
                {data.byDay.map((d) => (
                  <div key={d.day} className="ai-usage-day" title={`${dayLabel(d.day)}: ${num(d.tokens)} токенов, ${d.calls} обращений`}>
                    <span className="ai-usage-bar" style={{ height: `${Math.max(3, (d.tokens / peak) * 100)}%` }} />
                    <span className="ai-usage-daylabel">{dayLabel(d.day)}</span>
                  </div>
                ))}
              </div>
            )}

            <div className="drawer-section-title" style={{ marginTop: 14 }}>Куда уходит</div>
            <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>
              Здесь все места, где система обращается к ИИ. Пустая строка означает, что
              за период эта возможность не запускалась ни разу.
            </div>

            {GROUPS.map((g) => {
              const rows = data.byFeature.filter((f) => f.group === g.key);
              if (!rows.length) return null;
              return (
                <div key={g.key} className="ai-usage-group">
                  <div className="ai-usage-group-head">{g.title}</div>
                  {rows.map((f) => (
                    <div key={f.feature} className={`ai-usage-row${f.calls === 0 ? ' idle' : ''}`}>
                      <div className="ai-usage-what">
                        <div className="ai-usage-title">{f.title}</div>
                        <div className="dim ai-usage-where">
                          {f.where}
                          {f.models.length > 0 && ` · ${f.models.join(', ')}`}
                        </div>
                      </div>
                      <div className="ai-usage-nums">
                        {f.calls === 0 ? (
                          <span className="dim">не запускалось</span>
                        ) : (
                          <>
                            <span className="ai-usage-tokens">{num(f.tokens)}</span>
                            <span className="dim">{f.calls} раз · {money(f.cost)}</span>
                            {f.mockCalls > 0 && <span className="badge badge-warn">демо</span>}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              );
            })}
          </>
        )}
      </aside>
    </div>
  );
}
