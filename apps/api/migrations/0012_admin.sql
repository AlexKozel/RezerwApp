-- Администрирование платформы в alpha (D-005, D-057): CLI `pnpm admin`, ролью-мигратором.
-- Список всех Account с цифрами для поддержки; без клиентских данных и заметок (DATA_MODEL.md, раздел 4).
-- EXECUTE только у роли, применившей миграцию (мигратор), но не у приложения.

GRANT SELECT ON sms_ledger TO rezerwapp_lookup;
CREATE POLICY lookup_read ON sms_ledger FOR SELECT TO rezerwapp_lookup USING (true);

CREATE FUNCTION admin_accounts()
RETURNS TABLE (id uuid, name text, status text, plan text, sms_included integer, created_at timestamptz,
               owners text, staff_count integer, bookings_30d integer, sms_used_month integer)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT a.id, a.name, a.status, a.plan, a.sms_included, a.created_at,
         (SELECT string_agg(u.email, ', ' ORDER BY u.created_at) FROM public.users u WHERE u.account_id = a.id AND u.role = 'owner'),
         (SELECT count(*)::int FROM public.staff s WHERE s.account_id = a.id AND s.active),
         (SELECT count(*)::int FROM public.bookings b WHERE b.account_id = a.id AND b.created_at >= now() - interval '30 days'),
         (SELECT COALESCE(-sum(l.delta), 0)::int FROM public.sms_ledger l
           WHERE l.account_id = a.id AND l.delta < 0 AND l.at >= date_trunc('month', now()))
    FROM public.accounts a
   ORDER BY a.created_at
$$;

ALTER FUNCTION admin_accounts() OWNER TO rezerwapp_lookup;
REVOKE ALL ON FUNCTION admin_accounts() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_accounts() TO CURRENT_USER;
