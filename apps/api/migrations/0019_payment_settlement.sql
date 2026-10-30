-- Возврат резервационной оплаты (D-072). Деньги идут напрямую мастеру и возвращаются им вручную (D-010);
-- платформа фиксирует, что нужно сделать и что сделано.
--   to_check: запись закончилась (отклонение, истечение, отмена), пока оплата была «запрошена»: клиент мог
--             перевести деньги, а мастер не отметил получение. Мастер проверяет банк и возвращает;
--   refunded: мастер отметил, что вернул оплату (из returned или to_check);
--   not_received: мастер проверил, перевода не было (из to_check).
ALTER TABLE payment_requests DROP CONSTRAINT payment_requests_status_check;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_status_check
  CHECK (status IN ('requested', 'confirmed', 'kept', 'returned', 'to_check', 'refunded', 'not_received'));
-- Когда мастер закрыл вопрос (refunded или not_received).
ALTER TABLE payment_requests ADD COLUMN settled_at timestamptz;
ALTER TABLE payment_requests ADD CONSTRAINT payment_requests_settled
  CHECK ((settled_at IS NOT NULL) = (status IN ('refunded', 'not_received')));
CREATE INDEX payment_requests_due_idx ON payment_requests (account_id) WHERE status IN ('returned', 'to_check');
