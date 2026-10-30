-- Лист ожидания (D-068): клиент ждёт окно у специалиста на услугу в периоде; фоновая задача предлагает
-- освободившиеся слоты по очереди. Слот за клиентом не резервируется: предложение = уведомление с ссылкой.

CREATE TABLE waitlist_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  staff_id     uuid NOT NULL,
  client_id    uuid NOT NULL,
  service_id   uuid NOT NULL,
  variant_id   uuid NOT NULL,
  -- Местные даты Account, включительно.
  date_from    date NOT NULL,
  date_to      date NOT NULL,
  part_of_day  text NOT NULL DEFAULT 'any' CHECK (part_of_day IN ('any', 'morning', 'afternoon', 'evening')),
  -- waiting: в очереди; booked: записался к этому специалисту на день из периода; cancelled: вышел сам или
  -- убрал мастер; expired: период прошёл.
  status       text NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting', 'booked', 'cancelled', 'expired')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, id),
  CHECK (date_to >= date_from AND date_to - date_from <= 30),
  FOREIGN KEY (account_id, staff_id)   REFERENCES staff (account_id, id),
  FOREIGN KEY (account_id, client_id)  REFERENCES clients (account_id, id),
  FOREIGN KEY (account_id, service_id) REFERENCES services (account_id, id),
  FOREIGN KEY (account_id, variant_id) REFERENCES service_variants (account_id, id)
);
-- Очередь специалиста: порядок постановки.
CREATE INDEX waitlist_entries_queue_idx ON waitlist_entries (account_id, staff_id, created_at) WHERE status = 'waiting';
CREATE INDEX waitlist_entries_client_idx ON waitlist_entries (client_id) WHERE status = 'waiting';

-- Предложения: какой слот и до какого момента предложен. Один слот одному клиенту предлагается один раз;
-- пока предложение действует, этот слот другим из очереди не предлагается.
CREATE TABLE waitlist_offers (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL,
  entry_id    uuid NOT NULL,
  starts_at   timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entry_id, starts_at),
  CHECK (expires_at > created_at),
  FOREIGN KEY (account_id, entry_id) REFERENCES waitlist_entries (account_id, id) ON DELETE CASCADE
);
CREATE INDEX waitlist_offers_active_idx ON waitlist_offers (account_id, expires_at);

ALTER TABLE waitlist_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_entries
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
ALTER TABLE waitlist_offers ENABLE ROW LEVEL SECURITY;
ALTER TABLE waitlist_offers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON waitlist_offers
  USING (account_id = app_current_account()) WITH CHECK (account_id = app_current_account());
-- Права на таблицы rezerwapp_app получает через ALTER DEFAULT PRIVILEGES (0001).

-- Фоновая задача: Account с ожидающими клиентами (только id, D-046). Роль поиска видит лишь нужные столбцы.
GRANT SELECT (account_id, status) ON waitlist_entries TO rezerwapp_lookup;
CREATE POLICY lookup_read ON waitlist_entries FOR SELECT TO rezerwapp_lookup USING (true);

CREATE FUNCTION jobs_accounts_with_waitlist()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT e.account_id FROM public.waitlist_entries e WHERE e.status = 'waiting'
$$;

ALTER FUNCTION jobs_accounts_with_waitlist() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION jobs_accounts_with_waitlist() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_accounts_with_waitlist() TO rezerwapp_app;
