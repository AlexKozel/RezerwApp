-- Персональная скидка клиенту (D-070, этап 1 скидок).

-- Скидка клиента в % цены услуги, задаётся мастером; NULL = без скидки. До 50%: защита от опечатки «100».
ALTER TABLE clients ADD COLUMN discount_percent smallint CHECK (discount_percent BETWEEN 1 AND 50);

-- Снимок скидки в записи (D-015): price уже за вычетом скидки, discount_amount — сколько скидки дано
-- (для «Результатов»), discount_reason — откуда она (сейчас только personal; позже ко дню рождения).
ALTER TABLE bookings
  ADD COLUMN discount_percent smallint CHECK (discount_percent BETWEEN 1 AND 50),
  ADD COLUMN discount_amount numeric(10, 2) CHECK (discount_amount >= 0),
  ADD COLUMN discount_reason text CHECK (discount_reason IN ('personal')),
  ADD CONSTRAINT bookings_discount_complete CHECK (
    (discount_percent IS NULL) = (discount_amount IS NULL) AND (discount_percent IS NULL) = (discount_reason IS NULL)
  );

-- Может ли staff (наёмный мастер) ставить скидку своим клиентам; решает owner.
ALTER TABLE accounts ADD COLUMN staff_can_discount boolean NOT NULL DEFAULT false;
