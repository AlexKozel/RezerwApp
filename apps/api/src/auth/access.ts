import type { Db } from '../db/db';
import { NotFoundError } from '../errors';
import { ForbiddenError } from './auth.guard';
import type { Session } from './session-store';

/**
 * Доступ к данным конкретного специалиста внутри Account (DATA_MODEL.md, раздел 4):
 * owner и assistant работают со всеми специалистами, staff только со своим (staff.user_id).
 * Изоляцию между Account обеспечивает RLS; здесь только разграничение ролей внутри Account.
 */
export class StaffAccess {
  constructor(private readonly db: Db) {}

  /** id специалистов, с которыми может работать пользователь; null = со всеми. */
  async scope(session: Session): Promise<string[] | null> {
    if (session.role !== 'staff') return null;
    return this.db.withAccount(session.accountId, async (client) => {
      const rows = await client.query<{ id: string }>('SELECT id FROM staff WHERE user_id = $1', [session.userId]);
      return rows.rows.map((r) => r.id);
    });
  }

  async assertStaff(session: Session, staffId: string): Promise<void> {
    const scope = await this.scope(session);
    if (scope && !scope.includes(staffId)) throw new ForbiddenError();
  }

  async assertBooking(session: Session, bookingId: string): Promise<void> {
    const scope = await this.scope(session);
    if (!scope) return;
    const staffId = await this.db.withAccount(session.accountId, async (client) => {
      const row = await client.query<{ staff_id: string }>('SELECT staff_id FROM bookings WHERE id = $1', [bookingId]);
      return row.rows[0]?.staff_id;
    });
    if (!staffId) throw new NotFoundError('booking');
    if (!scope.includes(staffId)) throw new ForbiddenError();
  }
}
