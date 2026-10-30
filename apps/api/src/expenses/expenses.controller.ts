import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentSession, Roles, SessionGuard } from '../auth/auth.guard';
import type { Session } from '../auth/session-store';
import { Input } from '../http/validate';
import { EXPENSE_CATEGORIES, ExpensesService } from './expenses.service';

/** Журнал расходов (D-071): только owner. Даты YYYY-MM-DD по поясу Account. */
@Controller('expenses')
@UseGuards(SessionGuard)
@Roles(['owner'])
export class ExpensesController {
  constructor(private readonly expenses: ExpensesService) {}

  /** ?from=YYYY-MM-DD&to=YYYY-MM-DD (to не включается). */
  @Get()
  async list(@CurrentSession() s: Session, @Query() query: unknown) {
    const input = new Input(query);
    const from = input.date('from');
    const to = input.date('to');
    input.done();
    return this.expenses.list(s.accountId, from, to);
  }

  /** Тело: { spentOn, category, amount, note? }. */
  @Post()
  async add(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const expense = {
      spentOn: input.date('spentOn'),
      category: input.oneOf('category', EXPENSE_CATEGORIES),
      amount: input.money('amount'),
      note: input.optString('note', { max: 500 }) ?? null,
    };
    input.done();
    return this.expenses.add(s.accountId, s.userId, expense);
  }

  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.expenses.remove(s.accountId, id);
  }

  /** Повторяющийся расход. Тело: { category, amount, dayOfMonth: 1..28, startsOn, note? }. */
  @Post('recurring')
  async addRecurring(@CurrentSession() s: Session, @Body() body: unknown) {
    const input = new Input(body);
    const rule = {
      category: input.oneOf('category', EXPENSE_CATEGORIES),
      amount: input.money('amount'),
      dayOfMonth: input.int('dayOfMonth', { min: 1, max: 28 }),
      startsOn: input.date('startsOn'),
      note: input.optString('note', { max: 500 }) ?? null,
    };
    input.done();
    return this.expenses.addRecurring(s.accountId, rule);
  }

  /** Остановить со следующего месяца (текущий ещё начисляется). */
  @Post('recurring/:id/stop')
  @HttpCode(204)
  async stopRecurring(@CurrentSession() s: Session, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.expenses.stopRecurring(s.accountId, id);
  }
}
