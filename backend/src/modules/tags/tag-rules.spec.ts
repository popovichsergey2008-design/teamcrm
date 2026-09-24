import { canCreateTag, confidenceBand, findSimilarTag, normalizeTagName, tagsGatePassed } from './tag-rules';

describe('теги: имя, дубли, доверие к ИИ, право создавать', () => {
  it('имя для сравнения не зависит от регистра, пробелов и «ё»', () => {
    expect(normalizeTagName('  SEO ')).toBe('seo');
    expect(normalizeTagName('Программная   задача')).toBe('программная задача');
    // «Учёт» и «Учет» набирают по-разному, а тег имеют в виду один.
    expect(normalizeTagName('Складской учёт')).toBe(normalizeTagName('Складской учет'));
  });

  it('похожий тег находится по нормализованному имени, архивный не мешает', () => {
    const tags = [
      { id: '1', name: 'SEO', normalized_name: 'seo', archived_at: null },
      { id: '2', name: 'Импорт', normalized_name: 'импорт', archived_at: '2026-09-01' },
    ];
    expect(findSimilarTag('seo', tags)?.id).toBe('1');
    expect(findSimilarTag('Seo', tags)?.id).toBe('1');
    // Архивный не считается дублем: его нет в списке выбора.
    expect(findSimilarTag('импорт', tags)).toBeNull();
    // Разные слова дублем не считаем: «Реклама» и «Рекламация» — не одно и то же.
    expect(findSimilarTag('Рекламация', [{ id: '3', name: 'Реклама', archived_at: null }])).toBeNull();
  });

  it('уверенность модели делит подсказки на три корзины', () => {
    expect(confidenceBand(0.94)).toBe('sure');
    expect(confidenceBand(0.8)).toBe('sure');
    expect(confidenceBand(0.79)).toBe('unsure');
    expect(confidenceBand(0.5)).toBe('unsure');
    expect(confidenceBand(0.49)).toBe('drop');
    expect(confidenceBand('мусор')).toBe('drop');
    expect(confidenceBand(undefined)).toBe('drop');
  });

  it('право заводить теги считается по политике компании', () => {
    expect(canCreateTag('all', 'member')).toBe(true);
    expect(canCreateTag('managers', 'member')).toBe(false);
    expect(canCreateTag('managers', 'manager')).toBe(true);
    expect(canCreateTag('admins', 'manager')).toBe(false);
    expect(canCreateTag('admins', 'owner')).toBe(true);
    // Клиент в командные теги не ходит вовсе.
    expect(canCreateTag('all', 'client')).toBe(false);
  });

  it('проверка тегов перед созданием задачи: подтвердили набор или явно «без тегов»', () => {
    const on = { aiTagging: true, requireConfirmation: true };
    expect(tagsGatePassed(on, { tagIds: ['1'], confirmed: true })).toBe(true);
    expect(tagsGatePassed(on, { confirmedWithoutTags: true })).toBe(true);
    // Теги выбраны, но не подтверждены — это состояние «интерфейс не спросил».
    expect(tagsGatePassed(on, { tagIds: ['1'] })).toBe(false);
    expect(tagsGatePassed(on, { confirmed: true, tagIds: [] })).toBe(false);
    expect(tagsGatePassed(on, { tagIds: [], confirmed: false })).toBe(false);
    /*
      А вот клиент, который о тегах не знает вовсе (старое приложение на телефоне,
      импорт, интеграция), проходит: правило появилось сегодня, и ломать им постановку
      задач нельзя. Наш интерфейс поля присылает всегда — для людей правило работает.
    */
    expect(tagsGatePassed(on, {})).toBe(true);
    // Организация выключила разметку — ворота не работают вовсе.
    expect(tagsGatePassed({ aiTagging: false, requireConfirmation: true }, {})).toBe(true);
    expect(tagsGatePassed({ aiTagging: true, requireConfirmation: false }, {})).toBe(true);
  });
});
