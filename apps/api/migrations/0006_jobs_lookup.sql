-- Sprint 1: фоновые задачи (D-017, D-049). Задача работает под ролью приложения и без контекста Account
-- не видит строк, поэтому список Account с заявками pending отдаёт функция SECURITY DEFINER (как в 0002, D-046).
-- Функция возвращает только id Account; сами записи задача читает и меняет уже под RLS этого Account.

GRANT SELECT ON bookings TO rezerwapp_lookup;
CREATE POLICY lookup_read ON bookings FOR SELECT TO rezerwapp_lookup USING (true);

CREATE FUNCTION jobs_accounts_with_pending()
RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT b.account_id FROM public.bookings b WHERE b.status = 'pending'
$$;

ALTER FUNCTION jobs_accounts_with_pending() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION jobs_accounts_with_pending() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION jobs_accounts_with_pending() TO rezerwapp_app;

-- Поиск заявок, о которых пора напомнить мастеру (создана давно, ответа нет).
CREATE INDEX bookings_pending_created_idx ON bookings (account_id, created_at) WHERE status = 'pending';
