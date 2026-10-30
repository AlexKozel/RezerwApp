import { addDays, localDate } from '@rezerwapp/shared';
import type { PoolClient } from 'pg';
import type { Db } from '../db/db';
import { NotFoundError, ValidationError } from '../errors';

export const EXPENSE_CATEGORIES = ['rent', 'materials', 'training', 'marketing', 'taxes', 'equipment', 'software', 'other'] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

export interface Expense {
  id: string;
  spentOn: string;
  category: ExpenseCategory;
  amount: number;
  note: string | null;
}

export interface RecurringExpense {
  id: string;
  category: ExpenseCategory;
  amount: number;
  note: string | null;
  dayOfMonth: number;
  startsOn: string;
  endsOn: string | null;
}

/** Начисление повторяющегося расхода в периоде (считается по правилу, не хранится). */
export interface RecurringCharge {
  recurringId: string;
  chargedOn: string;
  category: ExpenseCategory;
  amount: number;
  note: string | null;
}

export interface ExpenseTotals {
  total: number;
  byCategory: Partial<Record<ExpenseCategory, number>>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Расходы и начисления за [fromDate, toDate) по категориям (в транзакции withAccount). */
export async function expenseTotals(client: PoolClient, fromDate: string, toDate: string): Promise<ExpenseTotals> {
  const rows = await client.query<{ category: ExpenseCategory; amount: string }>(
    `SELECT category, sum(amount) AS amount FROM (
       SELECT category, amount FROM expenses WHERE spent_on >= $1 AND spent_on < $2
       UNION ALL
       SELECT category, amount FROM recurring_charges($1, $2)
     ) e GROUP BY category`,
    [fromDate, toDate],
  );
  const byCategory: ExpenseTotals['byCategory'] = {};
  let total = 0;
  for (const r of rows.rows) {
    byCategory[r.category] = round2(Number(r.amount));
    total += Number(r.amount);
  }
  return { total: round2(total), byCategory };
}

/**
 * Журнал расходов «для себя» (D-071), только owner: разовые расходы и повторяющиеся правила (аренда, подписки).
 * Даты местные по поясу Account. Это не бухгалтерия: без VAT, фактур и KPiR.
 */
export class ExpensesService {
  constructor(private readonly db: Db) {}

  /** Период [from, to) в местных датах: разовые расходы, начисления правил и действующие в периоде правила. */
  async list(accountId: string, from: string, to: string) {
    if (!(from < to) || addDays(from, 366) < to) throw new ValidationError({ to: 'after from, at most a year' });
    return this.db.withAccount(accountId, async (client) => {
      const items = await client.query<{ id: string; spent_on: string; category: ExpenseCategory; amount: string; note: string | null }>(
        `SELECT id, to_char(spent_on, 'YYYY-MM-DD') AS spent_on, category, amount, note FROM expenses
          WHERE spent_on >= $1 AND spent_on < $2 ORDER BY spent_on DESC, created_at DESC`,
        [from, to],
      );
      const charges = await client.query<{ recurring_id: string; charged_on: string; category: ExpenseCategory; amount: string; note: string | null }>(
        `SELECT recurring_id, to_char(charged_on, 'YYYY-MM-DD') AS charged_on, category, amount, note FROM recurring_charges($1, $2) ORDER BY charged_on DESC`,
        [from, to],
      );
      const rules = await client.query<{
        id: string;
        category: ExpenseCategory;
        amount: string;
        note: string | null;
        day_of_month: number;
        starts_on: string;
        ends_on: string | null;
      }>(
        `SELECT id, category, amount, note, day_of_month, to_char(starts_on, 'YYYY-MM-DD') AS starts_on, to_char(ends_on, 'YYYY-MM-DD') AS ends_on
           FROM recurring_expenses WHERE ends_on IS NULL OR ends_on >= $1 ORDER BY created_at`,
        [from],
      );
      return {
        items: items.rows.map((r): Expense => ({ id: r.id, spentOn: r.spent_on, category: r.category, amount: Number(r.amount), note: r.note })),
        charges: charges.rows.map((r): RecurringCharge => ({
          recurringId: r.recurring_id,
          chargedOn: r.charged_on,
          category: r.category,
          amount: Number(r.amount),
          note: r.note,
        })),
        recurring: rules.rows.map((r): RecurringExpense => ({
          id: r.id,
          category: r.category,
          amount: Number(r.amount),
          note: r.note,
          dayOfMonth: r.day_of_month,
          startsOn: r.starts_on,
          endsOn: r.ends_on,
        })),
        totals: await expenseTotals(client, from, to),
      };
    });
  }

  async add(accountId: string, userId: string, input: { spentOn: string; category: ExpenseCategory; amount: number; note: string | null }): Promise<{ id: string }> {
    if (!(input.amount > 0)) throw new ValidationError({ amount: 'must be positive' });
    return this.db.withAccount(accountId, async (client) => {
      const row = await client.query<{ id: string }>(
        'INSERT INTO expenses (account_id, spent_on, category, amount, note, created_by) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [accountId, input.spentOn, input.category, input.amount, input.note, userId],
      );
      return { id: row.rows[0]!.id };
    });
  }

  async remove(accountId: string, id: string): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const deleted = await client.query('DELETE FROM expenses WHERE id = $1', [id]);
      if (deleted.rowCount === 0) throw new NotFoundError('expense');
    });
  }

  async addRecurring(
    accountId: string,
    input: { category: ExpenseCategory; amount: number; note: string | null; dayOfMonth: number; startsOn: string },
  ): Promise<{ id: string }> {
    if (!(input.amount > 0)) throw new ValidationError({ amount: 'must be positive' });
    return this.db.withAccount(accountId, async (client) => {
      const row = await client.query<{ id: string }>(
        'INSERT INTO recurring_expenses (account_id, category, amount, note, day_of_month, starts_on) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [accountId, input.category, input.amount, input.note, input.dayOfMonth, input.startsOn],
      );
      return { id: row.rows[0]!.id };
    });
  }

  /**
   * Остановить правило: текущий месяц ещё начисляется, со следующего нет. Прошлые месяцы не меняются.
   * Правило, которое ещё не начиналось, удаляется целиком.
   */
  async stopRecurring(accountId: string, id: string, now = new Date()): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const tz = (await client.query<{ timezone: string }>('SELECT timezone FROM accounts')).rows[0]!.timezone;
      const today = localDate(now, tz);
      const monthEnd = addDays(`${addDays(`${today.slice(0, 7)}-28`, 4).slice(0, 7)}-01`, -1);
      const rule = (await client.query<{ starts_on: string }>("SELECT to_char(starts_on, 'YYYY-MM-DD') AS starts_on FROM recurring_expenses WHERE id = $1", [id])).rows[0];
      if (!rule) throw new NotFoundError('recurring expense');
      if (rule.starts_on > monthEnd) await client.query('DELETE FROM recurring_expenses WHERE id = $1', [id]);
      else await client.query('UPDATE recurring_expenses SET ends_on = LEAST(COALESCE(ends_on, $2::date), $2::date) WHERE id = $1', [id, monthEnd]);
    });
  }
}
