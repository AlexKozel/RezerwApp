-- «Ненадёжный клиент» (D-066) и общие заметки салона с автором (D-067).

-- Поздняя отмена: клиент отменил позже дедлайна политики Account. Фиксируется в момент отмены: дедлайн
-- зависит от времени отмены, задним числом его не восстановить. Старые отмены (до этой миграции) не
-- заполняются: под FORCE RLS без контекста Account UPDATE затронул бы 0 строк (как в 0011).
-- Уважительная причина: мастер прощает неявку или позднюю отмену, случай не считается.
ALTER TABLE bookings
  ADD COLUMN late_cancel boolean NOT NULL DEFAULT false,
  ADD COLUMN excused_at timestamptz,
  ADD CONSTRAINT bookings_late_cancel_status CHECK (NOT late_cancel OR status = 'cancelled_by_client'),
  ADD CONSTRAINT bookings_excuse_incident CHECK (excused_at IS NULL OR status = 'no_show' OR (status = 'cancelled_by_client' AND late_cancel));

-- Ручная отметка мастера; снимается мастером или посещёнными визитами, как и автоматическая.
ALTER TABLE clients ADD COLUMN unreliable_since timestamptz;

-- Правила Account: порог случаев за 12 месяцев, визитов до снятия, предоплата для ненадёжных (% цены, D-014).
ALTER TABLE accounts
  ADD COLUMN unreliable_threshold smallint NOT NULL DEFAULT 2 CHECK (unreliable_threshold BETWEEN 1 AND 10),
  ADD COLUMN unreliable_redeem_visits smallint NOT NULL DEFAULT 2 CHECK (unreliable_redeem_visits BETWEEN 1 AND 10),
  ADD COLUMN unreliable_deposit_percent smallint CHECK (unreliable_deposit_percent BETWEEN 1 AND 50);

/*
 * Сколько посещённых визитов осталось клиенту до снятия отметки «ненадёжный»; NULL, если клиент надёжный.
 * Единственное место, где живёт правило (карточка, календарь, публичная запись):
 * - случай: неявка или поздняя отмена без уважительной причины за последние 12 месяцев, либо ручная отметка
 *   (сразу до порога);
 * - каждый случай обнуляет серию визитов; серия из unreliable_redeem_visits завершённых визитов обнуляет случаи.
 * События упорядочены по времени визита. SECURITY INVOKER: работает под RLS вызывающего Account.
 */
CREATE FUNCTION client_unreliable_visits_left(p_client uuid)
RETURNS integer
LANGUAGE plpgsql STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
  threshold integer;
  redeem integer;
  incidents integer := 0;
  streak integer := 0;
  e record;
BEGIN
  SELECT a.unreliable_threshold, a.unreliable_redeem_visits INTO threshold, redeem
    FROM clients c JOIN accounts a ON a.id = c.account_id
   WHERE c.id = p_client;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  FOR e IN
    SELECT at, kind FROM (
      SELECT b.starts_at AS at, CASE WHEN b.status = 'completed' THEN 'visit' ELSE 'incident' END AS kind
        FROM bookings b
       WHERE b.client_id = p_client
         AND b.starts_at > now() - interval '12 months'
         AND (b.status = 'completed'
              OR (b.excused_at IS NULL AND (b.status = 'no_show' OR (b.status = 'cancelled_by_client' AND b.late_cancel))))
      UNION ALL
      SELECT c.unreliable_since, 'manual' FROM clients c WHERE c.id = p_client AND c.unreliable_since IS NOT NULL
    ) events
    ORDER BY at
  LOOP
    IF e.kind = 'visit' THEN
      streak := streak + 1;
      IF streak >= redeem THEN
        incidents := 0;
      END IF;
    ELSE
      incidents := CASE WHEN e.kind = 'manual' THEN greatest(incidents, threshold) ELSE incidents + 1 END;
      streak := 0;
    END IF;
  END LOOP;

  IF incidents >= threshold THEN
    RETURN redeem - streak;
  END IF;
  RETURN NULL;
END
$$;

-- Автор заметки (D-067): заметки общие для салона, подпись помогает понять, чья формула или наблюдение.
-- Старые заметки без автора. Пользователь удалён: заметка остаётся, автор стирается.
ALTER TABLE client_notes
  ADD COLUMN author_id uuid,
  ADD CONSTRAINT client_notes_author_fk FOREIGN KEY (account_id, author_id) REFERENCES users (account_id, id) ON DELETE SET NULL (author_id);
