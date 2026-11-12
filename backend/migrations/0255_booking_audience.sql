-- #4892, п. 11: ссылки записи — кто может записаться, лимит в день у вида, привязка к задаче или клиенту,
-- распределение «по очереди» (turn) в дополнение к «ближайший» (nearest) и «у кого меньше встреч» (even).
ALTER TABLE booking_types ADD COLUMN IF NOT EXISTS audience VARCHAR(8) NOT NULL DEFAULT 'all';
ALTER TABLE booking_types ADD COLUMN IF NOT EXISTS max_per_day INT NULL;
ALTER TABLE booking_types ADD COLUMN IF NOT EXISTS task_id BIGINT NULL REFERENCES tasks(id) ON DELETE SET NULL;
ALTER TABLE booking_types ADD COLUMN IF NOT EXISTS client_id BIGINT NULL REFERENCES clients(id) ON DELETE SET NULL;
ALTER TABLE booking_types DROP CONSTRAINT IF EXISTS booking_types_rr_rule_check;
ALTER TABLE booking_types ADD CONSTRAINT booking_types_rr_rule_check CHECK (rr_rule IN ('nearest', 'even', 'turn'));
ALTER TABLE booking_types DROP CONSTRAINT IF EXISTS booking_types_audience_check;
ALTER TABLE booking_types ADD CONSTRAINT booking_types_audience_check CHECK (audience IN ('all', 'staff'));
ALTER TABLE booking_types DROP CONSTRAINT IF EXISTS booking_types_max_per_day_check;
ALTER TABLE booking_types ADD CONSTRAINT booking_types_max_per_day_check CHECK (max_per_day IS NULL OR max_per_day BETWEEN 1 AND 50);
-- кто записался из сотрудников (запись «только для сотрудников»)
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS booked_by BIGINT NULL REFERENCES users(id) ON DELETE SET NULL;
