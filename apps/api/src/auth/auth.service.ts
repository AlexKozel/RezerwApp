import { randomUUID } from 'node:crypto';
import { isLocale, type Locale } from '@rezerwapp/shared';
import { DUMMY_PASSWORD_HASH, PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH, hashPassword, verifyPassword } from '../crypto/password';
import type { Db } from '../db/db';
import { AppError, ConflictError, ValidationError } from '../errors';
import type { RateLimiter } from '../rate-limit';
import type { Session, SessionStore, UserRole } from './session-store';

export class InvalidCredentialsError extends AppError {
  constructor() {
    super('INVALID_CREDENTIALS', 'Email or password is incorrect');
  }
}

export interface CreateMasterInput {
  accountName: string;
  email: string;
  password: string;
  locale?: Locale;
  timezone?: string;
}

// Неудачные входы: на email (защита конкретного аккаунта) и на IP (перебор многих email).
const LOGIN_WINDOW_SEC = 15 * 60;
const LOGIN_FAILS_PER_EMAIL = 10;
const LOGIN_ATTEMPTS_PER_IP = 50;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function checkPassword(password: string): void {
  if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) {
    throw new ValidationError({ password: `${PASSWORD_MIN_LENGTH}-${PASSWORD_MAX_LENGTH} characters` });
  }
}

function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Новый Account с владельцем. В alpha доступ выдаётся вручную (D-005), поэтому вызывается из CLI
 * (src/cli/create-master.ts), а не публичным эндпоинтом.
 */
export async function createMaster(db: Db, input: CreateMasterInput): Promise<{ accountId: string; userId: string }> {
  const email = input.email.trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new ValidationError({ email: 'invalid email' });
  checkPassword(input.password);
  const locale = input.locale ?? 'pl';
  if (!isLocale(locale)) throw new ValidationError({ locale: 'unknown locale' });
  const timezone = input.timezone ?? 'Europe/Warsaw';
  if (!isTimeZone(timezone)) throw new ValidationError({ timezone: 'unknown time zone' });

  const passwordHash = await hashPassword(input.password);
  const accountId = randomUUID();
  try {
    return await db.withAccount(accountId, async (client) => {
      await client.query('INSERT INTO accounts (id, name, locale, timezone) VALUES ($1, $2, $3, $4)', [
        accountId,
        input.accountName.trim(),
        locale,
        timezone,
      ]);
      const user = await client.query<{ id: string }>(
        "INSERT INTO users (account_id, email, role, password_hash) VALUES ($1, $2, 'owner', $3) RETURNING id",
        [accountId, email, passwordHash],
      );
      return { accountId, userId: user.rows[0]!.id };
    });
  } catch (error) {
    if ((error as { constraint?: string }).constraint === 'users_email_uq') {
      throw new ConflictError('EMAIL_TAKEN', 'Email is already registered');
    }
    throw error;
  }
}

/**
 * Вход мастера (D-041). Account до входа неизвестен, поэтому пользователь ищется функцией auth_find_user
 * (SECURITY DEFINER, миграция 0002), а не чтением users под RLS.
 */
export class AuthService {
  constructor(
    private readonly db: Db,
    private readonly sessions: SessionStore,
    private readonly limiter: RateLimiter,
  ) {}

  /** Проверяет email и пароль, создаёт сессию. Ответ одинаков для «нет такого email» и «неверный пароль». */
  async login(emailInput: string, password: string, ip: string): Promise<{ token: string; session: Session }> {
    const email = emailInput.trim().toLowerCase();
    await this.limiter.hit(`login:ip:${ip}`, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_SEC);
    await this.limiter.check(`login:email:${email}`, LOGIN_FAILS_PER_EMAIL);

    const found = await this.db.pool.query<{ user_id: string; account_id: string; role: UserRole; password_hash: string }>(
      'SELECT user_id, account_id, role, password_hash FROM auth_find_user($1)',
      [email],
    );
    const user = found.rows[0];
    const ok = await verifyPassword(password.slice(0, PASSWORD_MAX_LENGTH), user?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!user || !ok) {
      await this.limiter.hit(`login:email:${email}`, Number.MAX_SAFE_INTEGER, LOGIN_WINDOW_SEC);
      throw new InvalidCredentialsError();
    }

    await this.limiter.reset(`login:email:${email}`);
    const data = { userId: user.user_id, accountId: user.account_id, role: user.role };
    const token = await this.sessions.create(data);
    return { token, session: { ...data, createdAt: new Date().toISOString() } };
  }

  /** Данные для интерфейса мастера: Account (название, пояс, язык), email и специалист пользователя. */
  async profile(accountId: string, userId: string) {
    return this.db.withAccount(accountId, async (client) => {
      const row = (await client.query<{
        name: string;
        timezone: string;
        locale: string;
        email: string;
        staff_id: string | null;
        must_change_password: boolean;
        track_visit_costs: boolean;
      }>(
        `SELECT a.name, a.timezone, a.locale, u.email, s.id AS staff_id, u.must_change_password, a.track_visit_costs
           FROM users u JOIN accounts a ON a.id = u.account_id LEFT JOIN staff s ON s.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      )).rows[0];
      return row
        ? {
            accountName: row.name,
            timeZone: row.timezone,
            locale: row.locale,
            email: row.email,
            staffId: row.staff_id,
            mustChangePassword: row.must_change_password,
            // D-071: показывать ли у визитов поле «доп. затраты».
            trackVisitCosts: row.track_visit_costs,
          }
        : null;
    });
  }

  async logout(token: string): Promise<void> {
    await this.sessions.destroy(token);
  }
}
