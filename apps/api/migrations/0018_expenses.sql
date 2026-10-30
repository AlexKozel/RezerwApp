-- Журнал расходов «для себя» и разовые затраты на визит (D-071). Не бухгалтерия: без VAT, фактур и KPiR.

CREATE TABLE expenses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  -- Местная дата Account.
  spent_on    date NOT NULL,
  category    text NOT NULL CHECK (category IN ('rent', 'materials', 'training', 'marketing', 'taxes', 'equipment', 'software', 'other')),
  amount      numeric(10, 2) NOT NULL CHECK (amount > 0),
  note        text CHECK (length(note) <= 500),
  created_by  uuid,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (account_id, created_by) REFERENCES users (account_id, id) ON DELETE SET NULL (created_by)
);
CREATE INDEX expenses_account_date_idx ON expenses (account_id, spent_on);

-- Повторяющийся расход: начисляется в day_of_month каждого месяца с starts_on по ends_on включительно.
-- Начисления считаются по правилу, строки-копии не создаются. Сумма правила не меняется задним числом:
-- изменение = остановить правило (ends_on) и завести новое.
CREATE TABLE recurring_expenses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  category      text NOT NULL CHECK (category IN ('rent', 'materials', 'training', 'marketing', 'taxes', 'equipment', 'software', 'other')),
  amount        numeric(10, 2) NOT NULL CHECK (amount > 0),
  note          text CHECK (length(note) <= 500),
  -- До 28: начисление есть в каждом месяце, включая февраль.
  day_of_month  smallint NOT NULL CHECK (day_of_month BETWEEN 1 AND 28),
  starts_on     date NOT NULL,
  ends_on       date,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on IS NULL OR ends_on >= starts_on)
);
CREATE INDEX recurring_expenses_account_idx ON recurring_expenses (account_id);

-- Начисления правил в периоде [from_date, to_date): дата и сумма (SECURITY INVOKER, под RLS вызывающего).
CREATE FUNCTION recurring_charges(from_date date, to_date date)
RETURNS TABLE (recurring_id uuid, charged_on date, category text, amount numeric, note text)
LANGUAGE sql STABLE
SET search_path = public, pg_temp
AS $$
  SELECT r.id, c.charged_on, r.category, r.amount, r.note
    FROM recurring_expenses r
   CROSS JOIN LATERAL (
     SELECT (date_trunc('month', m) + make_interval(days => r.day_of_month - 1))::date AS charged_on
       FROM generate_series(date_trunc('month', greatest(r.starts_on, from_date)), date_trunc('month', to_date), interval '1 month') AS m
   ) c
   WHERE c.charged_on >= r.starts_on AND (r.ends_on IS NULL OR c.charged_on <= r.ends_on)
     AND c.charged_on >= from_date AND c.charged_on < to_date
$$;

ALTER TABLE expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON expenses
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
ALTER TABLE recurring_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE recurring_expenses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON recurring_expenses
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());

-- Разовые затраты на конкретный визит (дорогой дизайн, стразы): опция Account, по умолчанию выключена.
ALTER TABLE bookings ADD COLUMN extra_cost numeric(10, 2) CHECK (extra_cost >= 0);
ALTER TABLE accounts ADD COLUMN track_visit_costs boolean NOT NULL DEFAULT false;
