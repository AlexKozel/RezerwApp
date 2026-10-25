import type { PoolClient } from 'pg';
import { hashPassword, verifyPassword } from '../crypto/password';
import type { Db } from '../db/db';
import { ConflictError, NotFoundError, ValidationError } from '../errors';
import { checkPassword, InvalidCredentialsError } from './auth.service';
import type { UserRole } from './session-store';

export interface AccountUser {
  id: string;
  email: string;
  role: UserRole;
  staffId: string | null;
  /** Временный пароль ещё не сменён (D-061). */
  mustChangePassword: boolean;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Пользователи Account (DATA_MODEL.md, раздел 4). Создаёт и меняет их только owner (проверка в контроллере).
 * Пока нет почтового провайдера, owner задаёт начальный пароль сам и передаёт его сотруднику;
 * сотрудник меняет его через POST /auth/password.
 */
export class UsersService {
  constructor(private readonly db: Db) {}

  async list(accountId: string): Promise<AccountUser[]> {
    return this.db.withAccount(accountId, async (client) => {
      const rows = await client.query<{ id: string; email: string; role: UserRole; staff_id: string | null; must_change_password: boolean }>(
        `SELECT u.id, u.email, u.role, s.id AS staff_id, u.must_change_password
           FROM users u LEFT JOIN staff s ON s.user_id = u.id
          ORDER BY u.created_at`,
      );
      return rows.rows.map((r) => ({ id: r.id, email: r.email, role: r.role, staffId: r.staff_id, mustChangePassword: r.must_change_password }));
    });
  }

  async create(accountId: string, input: { email: string; role: UserRole; password: string; staffId: string | null }): Promise<AccountUser> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) throw new ValidationError({ email: 'invalid email' });
    checkPassword(input.password);
    const passwordHash = await hashPassword(input.password);
    try {
      return await this.db.withAccount(accountId, async (client) => {
        const row = await client.query<{ id: string }>(
          // Пароль задал owner: сотрудник обязан сменить его при первом входе (D-061).
          'INSERT INTO users (account_id, email, role, password_hash, must_change_password) VALUES ($1, $2, $3, $4, true) RETURNING id',
          [accountId, email, input.role, passwordHash],
        );
        const id = row.rows[0]!.id;
        if (input.staffId) await this.linkStaff(client, id, input.staffId);
        return { id, email, role: input.role, staffId: input.staffId, mustChangePassword: true };
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'users_email_uq') throw new ConflictError('EMAIL_TAKEN', 'Email is already registered');
      throw error;
    }
  }

  /** Меняет роль и привязку к специалисту. staffId: undefined = не менять, null = отвязать. */
  async update(accountId: string, userId: string, patch: { role?: UserRole; staffId?: string | null }): Promise<AccountUser> {
    await this.db.withAccount(accountId, async (client) => {
      const current = await this.lockUser(client, userId);
      if (patch.role && patch.role !== 'owner' && current.role === 'owner') await this.assertAnotherOwner(client, userId);
      if (patch.role) await client.query('UPDATE users SET role = $2 WHERE id = $1', [userId, patch.role]);
      if (patch.staffId !== undefined) {
        await client.query('UPDATE staff SET user_id = NULL WHERE user_id = $1', [userId]);
        if (patch.staffId) await this.linkStaff(client, userId, patch.staffId);
      }
    });
    const user = (await this.list(accountId)).find((u) => u.id === userId);
    if (!user) throw new NotFoundError('user');
    return user;
  }

  /** Удаляет пользователя. Его сессии перестают работать сразу: SessionGuard не найдёт пользователя. */
  async remove(accountId: string, userId: string): Promise<void> {
    await this.db.withAccount(accountId, async (client) => {
      const current = await this.lockUser(client, userId);
      if (current.role === 'owner') await this.assertAnotherOwner(client, userId);
      await client.query('DELETE FROM users WHERE id = $1', [userId]);
    });
  }

  async changePassword(accountId: string, userId: string, currentPassword: string, newPassword: string): Promise<void> {
    checkPassword(newPassword);
    if (newPassword === currentPassword) throw new ValidationError({ newPassword: 'must differ from the current password' });
    const stored = await this.db.withAccount(accountId, async (client) => {
      const row = await client.query<{ password_hash: string | null }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
      return row.rows[0]?.password_hash ?? null;
    });
    if (!stored || !(await verifyPassword(currentPassword, stored))) throw new InvalidCredentialsError();
    const hash = await hashPassword(newPassword);
    await this.db.withAccount(accountId, (client) =>
      client.query('UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1', [userId, hash]),
    );
  }

  /**
   * Сброс пароля сотрудника owner'ом (сотрудник забыл пароль, почты пока нет): новый временный пароль
   * и обязательная смена при входе. Свой пароль owner меняет через /auth/password.
   */
  async resetPassword(accountId: string, actorId: string, userId: string, password: string): Promise<void> {
    if (actorId === userId) throw new ValidationError({ user: 'use /auth/password to change your own password' });
    checkPassword(password);
    const hash = await hashPassword(password);
    await this.db.withAccount(accountId, async (client) => {
      const updated = await client.query('UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1', [userId, hash]);
      if (updated.rowCount === 0) throw new NotFoundError('user');
    });
  }

  private async lockUser(client: PoolClient, userId: string): Promise<{ role: UserRole }> {
    // Блокировка всех owner Account сериализует изменения ролей: два owner не разжалуют друг друга одновременно.
    await client.query("SELECT 1 FROM users WHERE role = 'owner' FOR UPDATE");
    const row = (await client.query<{ role: UserRole }>('SELECT role FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    if (!row) throw new NotFoundError('user');
    return row;
  }

  private async assertAnotherOwner(client: PoolClient, userId: string): Promise<void> {
    const others = await client.query("SELECT 1 FROM users WHERE role = 'owner' AND id <> $1", [userId]);
    if (others.rowCount === 0) throw new ConflictError('LAST_OWNER', 'Account must keep at least one owner');
  }

  private async linkStaff(client: PoolClient, userId: string, staffId: string): Promise<void> {
    try {
      const updated = await client.query('UPDATE staff SET user_id = $1 WHERE id = $2 AND (user_id IS NULL OR user_id = $1)', [userId, staffId]);
      if (updated.rowCount === 0) {
        const exists = await client.query('SELECT 1 FROM staff WHERE id = $1', [staffId]);
        if (exists.rowCount === 0) throw new NotFoundError('staff');
        throw new ConflictError('STAFF_LINKED', 'Staff member is linked to another user');
      }
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'staff_user_uq') throw new ConflictError('STAFF_LINKED', 'User is already linked to staff');
      throw error;
    }
  }
}
