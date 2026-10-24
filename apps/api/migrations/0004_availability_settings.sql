-- Sprint 1: параметры доступности специалиста (D-043). Значения по умолчанию: шаг 15 минут,
-- запись не дальше 60 дней вперёд и не позже чем за 2 часа до начала.

ALTER TABLE staff
  ADD COLUMN slot_step_min        integer NOT NULL DEFAULT 15  CHECK (slot_step_min BETWEEN 5 AND 240),
  ADD COLUMN booking_horizon_days integer NOT NULL DEFAULT 60  CHECK (booking_horizon_days BETWEEN 1 AND 365),
  ADD COLUMN min_lead_minutes     integer NOT NULL DEFAULT 120 CHECK (min_lead_minutes BETWEEN 0 AND 10080);

COMMENT ON COLUMN working_hours.weekday IS '0 = воскресенье … 6 = суббота (как EXTRACT(dow) и Date.getUTCDay)';
COMMENT ON TABLE working_hours IS 'Регулярный график. День недели без строк = выходной (D-043)';
COMMENT ON TABLE time_blocks IS 'Разовые блоки: обед, отпуск, выходной день целиком в часовом поясе Account (D-043)';

CREATE INDEX working_hours_staff_idx ON working_hours (staff_id, weekday);
CREATE INDEX time_blocks_staff_range_idx ON time_blocks USING gist (staff_id, range);
