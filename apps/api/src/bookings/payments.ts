import type { BookingStatus } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';

export type LateCancelRule = 'keep' | 'transfer' | 'refund';

/** Значения по умолчанию, если у записи нет снимка политики (D-012). */
export const DEFAULT_POLICY = { freeCancelHours: 24, maxReschedules: 1, depositOnLateCancel: 'keep' as LateCancelRule };

/**
 * Судьба резервационной оплаты при смене статуса записи (D-013, BOOKING_FLOW.md, раздел 4).
 * Платформа только фиксирует решение, деньги возвращает или оставляет себе мастер (D-010).
 * - pending → confirmed: мастер проверил перевод и одобрил заявку, оплата подтверждена;
 * - отмена мастером, отклонение, истечение: вернуть;
 * - отмена клиентом до дедлайна: вернуть; после дедлайна и неявка: по правилу политики
 *   (keep и transfer: остаётся у мастера, transfer означает зачёт в следующий визит; refund: вернуть);
 * - завершение: остаётся у мастера (засчитывается в цену);
 * - перенос: оплата переходит на новую запись (меняется booking_id, не статус).
 */
export function paymentOutcome(to: BookingStatus, late: boolean, rule: LateCancelRule): 'confirmed' | 'kept' | 'returned' | null {
  switch (to) {
    case 'confirmed':
      return 'confirmed';
    case 'cancelled_by_master':
    case 'rejected':
    case 'expired':
      return 'returned';
    case 'cancelled_by_client':
      return late && rule !== 'refund' ? 'kept' : 'returned';
    case 'no_show':
      return rule === 'refund' ? 'returned' : 'kept';
    case 'completed':
      return 'kept';
    default:
      return null;
  }
}

/**
 * Применяет исход к запросу оплаты записи. «Подтверждена» ставится только из «запрошена»; «удержана» и
 * «возвращена» из «подтверждена». Если запись закончилась (отклонение, истечение, отмена), пока оплата была
 * «запрошена», платформа не знает, переводил ли клиент деньги: статус to_check, мастер проверяет банк и
 * возвращает или отмечает, что перевода не было (D-072).
 */
export async function settlePayment(
  client: PoolClient,
  bookingId: string,
  outcome: 'confirmed' | 'kept' | 'returned' | null,
): Promise<string | null> {
  if (!outcome) return null;
  if (outcome === 'returned') {
    const updated = await client.query<{ status: string }>(
      `UPDATE payment_requests SET status = CASE WHEN status = 'confirmed' THEN 'returned' ELSE 'to_check' END
        WHERE booking_id = $1 AND status IN ('confirmed', 'requested') RETURNING status`,
      [bookingId],
    );
    return updated.rows[0]?.status ?? null;
  }
  const from = outcome === 'confirmed' ? 'requested' : 'confirmed';
  const updated = await client.query<{ status: string }>(
    'UPDATE payment_requests SET status = $2 WHERE booking_id = $1 AND status = $3 RETURNING status',
    [bookingId, outcome, from],
  );
  return updated.rows[0]?.status ?? null;
}
