import { localDate } from '@rezerwapp/shared';
import type { Db } from '../db/db';
import { expenseTotals, type ExpenseTotals } from '../expenses/expenses.service';
import { ValidationError } from '../errors';

/** Максимальный период отчёта. */
export const ANALYTICS_MAX_DAYS = 400;

const STATUSES = ['pending', 'confirmed', 'completed', 'no_show', 'cancelled_by_client', 'cancelled_by_master', 'rejected', 'expired', 'rescheduled'] as const;

export interface ServiceMargin {
  serviceId: string;
  name: Record<string, string>;
  completed: number;
  revenue: number;
  /** null, если у услуги не указана себестоимость (cost_price). */
  cost: number | null;
  margin: number | null;
}

export interface AnalyticsSummary {
  period: { from: Date; to: Date };
  bookings: Record<(typeof STATUSES)[number], number>;
  /** Доля неявок среди состоявшихся визитов (completed + no_show), отдельно с резервационной оплатой и без. */
  noShowRate: { all: number | null; withFee: number | null; withoutFee: number | null };
  bookingFee: {
    /** Записи с оплатой, которые завершились визитом. */
    completedWithFee: number;
    /** Удержанные мастером оплаты (D-013): при неявке и при поздней отмене. */
    keptOnNoShow: number;
    keptOnLateCancel: number;
  };
  /** Выручка завершённых визитов по цене на момент записи (для старых записей без снимка: текущая цена). */
  revenue: number;
  revenueFromPriceSnapshot: boolean;
  /** Сколько скидок дано на завершённых визитах (D-070). */
  discounts: number;
  /** Разовые затраты на завершённые визиты (D-071); входят в себестоимость услуг. */
  visitCosts: number;
  /** Расходы Account за период и «осталось себе» (D-071): только для всего Account (owner), staff получает null. */
  expenses: ExpenseTotals | null;
  profit: number | null;
  /** Условное сравнение с комиссией маркетплейса (BOOKING_FLOW.md, раздел 9): только при заданной ставке. */
  marketplaceCommission: { percent: number; amount: number; formula: string } | null;
  services: ServiceMargin[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const rate = (part: number, whole: number) => (whole > 0 ? round2(part / whole) : null);

/**
 * Метрики «сколько вы сэкономили» и маржа услуг (D-056, BOOKING_FLOW.md, раздел 9) за период по времени визита.
 * staffIds: ограничение специалистами (роль staff видит только свои записи); null = весь Account.
 */
export class AnalyticsService {
  constructor(private readonly db: Db) {}

  async summary(
    accountId: string,
    staffIds: string[] | null,
    from: Date,
    to: Date,
    commissionPercent: number | null,
  ): Promise<AnalyticsSummary> {
    if (!(from < to) || to.getTime() - from.getTime() > ANALYTICS_MAX_DAYS * 24 * 3_600_000) {
      throw new ValidationError({ to: `after from, at most ${ANALYTICS_MAX_DAYS} days` });
    }
    return this.db.withAccount(accountId, async (client) => {
      const scope = 'b.starts_at >= $1 AND b.starts_at < $2 AND ($3::uuid[] IS NULL OR b.staff_id = ANY($3))';
      const params = [from, to, staffIds];

      const byStatus = await client.query<{ status: (typeof STATUSES)[number]; n: number; with_fee: number }>(
        `SELECT b.status, count(*)::int AS n, count(pr.id)::int AS with_fee
           FROM bookings b LEFT JOIN payment_requests pr ON pr.booking_id = b.id
          WHERE ${scope}
          GROUP BY b.status`,
        params,
      );
      const bookings = Object.fromEntries(STATUSES.map((s) => [s, 0])) as AnalyticsSummary['bookings'];
      const fee = { completed: 0, noShow: 0 };
      for (const r of byStatus.rows) {
        bookings[r.status] = r.n;
        if (r.status === 'completed') fee.completed = r.with_fee;
        if (r.status === 'no_show') fee.noShow = r.with_fee;
      }

      const kept = await client.query<{ status: string; amount: string }>(
        `SELECT b.status, COALESCE(sum(pr.amount), 0) AS amount
           FROM bookings b JOIN payment_requests pr ON pr.booking_id = b.id AND pr.status = 'kept'
          WHERE ${scope} AND b.status IN ('no_show', 'cancelled_by_client')
          GROUP BY b.status`,
        params,
      );
      const keptBy = (status: string) => Number(kept.rows.find((r) => r.status === status)?.amount ?? 0);

      const services = await client.query<{
        service_id: string;
        name_i18n: Record<string, string>;
        completed: number;
        revenue: string;
        cost_price: string | null;
        extra: string;
        missing_snapshot: number;
      }>(
        `SELECT s.id AS service_id, s.name_i18n, count(*)::int AS completed,
                sum(COALESCE(b.price, ss.override_price, v.price)) AS revenue,
                s.cost_price, COALESCE(sum(b.extra_cost), 0) AS extra, count(*) FILTER (WHERE b.price IS NULL)::int AS missing_snapshot
           FROM bookings b
           JOIN services s ON s.id = b.service_id
           JOIN service_variants v ON v.id = b.variant_id
           LEFT JOIN staff_services ss ON ss.staff_id = b.staff_id AND ss.service_id = b.service_id
          WHERE ${scope} AND b.status = 'completed'
          GROUP BY s.id
          ORDER BY sum(COALESCE(b.price, ss.override_price, v.price)) DESC`,
        params,
      );
      const serviceRows: ServiceMargin[] = services.rows.map((r) => {
        const revenue = round2(Number(r.revenue));
        // Себестоимость: материалы по услуге (cost_price × визиты) плюс разовые затраты визитов (D-071).
        const extra = Number(r.extra);
        const cost = r.cost_price === null && extra === 0 ? null : round2(Number(r.cost_price ?? 0) * r.completed + extra);
        return { serviceId: r.service_id, name: r.name_i18n, completed: r.completed, revenue, cost, margin: cost === null ? null : round2(revenue - cost) };
      });
      const revenue = round2(serviceRows.reduce((sum, s) => sum + s.revenue, 0));
      // Расходы салона только для всего Account: staff видит свои визиты, но не аренду и налоги салона.
      let expenses: ExpenseTotals | null = null;
      if (staffIds === null) {
        const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM accounts')).rows[0]!.timezone;
        expenses = await expenseTotals(client, localDate(from, tz), localDate(to, tz));
      }
      const discounts = (await client.query<{ total: string | null }>(
        `SELECT sum(b.discount_amount) AS total FROM bookings b WHERE ${scope} AND b.status = 'completed'`,
        params,
      )).rows[0]!.total;

      const attended = bookings.completed + bookings.no_show;
      const attendedWithFee = fee.completed + fee.noShow;
      return {
        period: { from, to },
        bookings,
        noShowRate: {
          all: rate(bookings.no_show, attended),
          withFee: rate(fee.noShow, attendedWithFee),
          withoutFee: rate(bookings.no_show - fee.noShow, attended - attendedWithFee),
        },
        bookingFee: { completedWithFee: fee.completed, keptOnNoShow: keptBy('no_show'), keptOnLateCancel: keptBy('cancelled_by_client') },
        revenue,
        revenueFromPriceSnapshot: services.rows.every((r) => r.missing_snapshot === 0),
        discounts: round2(Number(discounts ?? 0)),
        visitCosts: round2(services.rows.reduce((sum, r) => sum + Number(r.extra), 0)),
        expenses,
        profit: expenses ? round2(revenue - serviceRows.reduce((sum, s) => sum + (s.cost ?? 0), 0) - expenses.total) : null,
        marketplaceCommission:
          commissionPercent === null
            ? null
            : {
                percent: commissionPercent,
                amount: round2((revenue * commissionPercent) / 100),
                formula: `revenue × ${commissionPercent}% = ${round2((revenue * commissionPercent) / 100)}`,
              },
        services: serviceRows,
      };
    });
  }
}
