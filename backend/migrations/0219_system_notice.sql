-- Объявление для всех пользователей QEVO (30.10, заказчик: «включи окно, что идёт
-- обновление на час-полтора»). Плашка сверху у всех компаний; сама исчезает в ends_at.
-- Ставит и снимает администратор техотдела (POST/DELETE /api/platform/notice).
CREATE TABLE system_notices (
    id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    text        TEXT NOT NULL,
    level       VARCHAR(16) NOT NULL DEFAULT 'warn' CHECK (level IN ('info', 'warn')),
    starts_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    ends_at     TIMESTAMPTZ NOT NULL,
    created_by  BIGINT NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_system_notices_active ON system_notices (ends_at);

-- Первое объявление — с момента выкладки на полтора часа.
INSERT INTO system_notices (text, level, ends_at) VALUES (
  'Идёт обновление QEVO — примерно час-полтора. Возможны короткие перебои: если что-то не сохранилось, повторите через минуту. Данные не пострадают.',
  'warn', now() + interval '90 minutes'
);
