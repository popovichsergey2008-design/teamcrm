import { Icon } from '../components/Icon';
import { EmptyState } from '../components/EmptyState';
import { navigate } from '../lib/router';

/**
 * «Пульс команды» — экран руководителя.
 *
 * Сейчас это честная заглушка: данные для блоков уже считаются на сервере
 * (velocity, forecast, экономика), но собрать из них дашборд — отдельный шаг (Ш6).
 * Показывать вместо этого выдуманные проценты нельзя: по такому экрану принимают
 * кадровые решения, и один неверный «85% риска» стоит доверия ко всей системе.
 */
export function RadarPage() {
  return (
    <div className="page">
      <div className="page-head">
        <h2><Icon name="chart" size={18} /> Пульс команды</h2>
      </div>
      <div className="radar-body">
        <EmptyState
          icon="chart"
          title="Дашборд собирается"
          hint={
            'Здесь будут прогресс проектов, тепловая карта загрузки, узкие места и метрики скорости. '
            + 'Пока разделы наполняются, риски по срокам видны в «Фокусе дня» — в колонке порученных задач.'
          }
          action={{ label: 'Открыть Фокус дня', onClick: () => navigate({ section: 'focus' }) }}
        />
      </div>
    </div>
  );
}
