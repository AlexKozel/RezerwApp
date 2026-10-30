import type { PoolClient } from 'pg';

/** Откуда скидка; позже добавится скидка ко дню рождения (этап 2, с согласием на маркетинг). */
export type DiscountReason = 'personal';

export interface Discount {
  percent: number;
  reason: DiscountReason;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Скидки не складываются: из применимых берётся наибольшая (D-070). */
export function bestDiscount(candidates: Array<Discount | null>): Discount | null {
  let best: Discount | null = null;
  for (const d of candidates) if (d && (!best || d.percent > best.percent)) best = d;
  return best;
}

/** Цена со скидкой и сумма скидки (обе до копеек); без скидки сумма null. */
export function applyDiscount(price: number, discount: Discount | null): { price: number; amount: number | null } {
  if (!discount) return { price, amount: null };
  const amount = round2((price * discount.percent) / 100);
  return { price: round2(price - amount), amount };
}

/** Скидка клиента сейчас (в транзакции withAccount). */
export async function clientDiscount(client: PoolClient, clientId: string): Promise<Discount | null> {
  const row = (await client.query<{ discount_percent: number | null }>('SELECT discount_percent FROM clients WHERE id = $1', [clientId])).rows[0];
  const personal: Discount | null = row?.discount_percent ? { percent: row.discount_percent, reason: 'personal' } : null;
  return bestDiscount([personal]);
}

/** Перенос сохраняет скидку исходной записи (снимок условий, D-015), даже если скидку клиента потом изменили. */
export async function bookingDiscount(client: PoolClient, bookingId: string): Promise<Discount | null> {
  const row = (await client.query<{ discount_percent: number | null; discount_reason: DiscountReason | null }>(
    'SELECT discount_percent, discount_reason FROM bookings WHERE id = $1',
    [bookingId],
  )).rows[0];
  return row?.discount_percent && row.discount_reason ? { percent: row.discount_percent, reason: row.discount_reason } : null;
}
