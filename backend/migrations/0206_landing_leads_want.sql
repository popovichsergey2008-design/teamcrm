-- Что прислать посетителю с рекламной страницы (#4648): видео работы приложения или план переезда.
ALTER TABLE landing_leads ADD COLUMN IF NOT EXISTS want TEXT NULL;
