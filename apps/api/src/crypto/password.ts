import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// scrypt из node:crypto, без нативных зависимостей. N=2^15, r=8: ~32 МБ и десятки мс на проверку.
const PARAMS = { N: 2 ** 15, r: 8, p: 1 } as const;
const KEY_LEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

function derive(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFKC'), salt, KEY_LEN, { ...options, maxmem: MAXMEM }, (error, key) =>
      error ? reject(error) : resolve(key),
    );
  });
}

/** Формат: scrypt$N$r$p$salt$hash (base64). Параметры хранятся в строке, чтобы их можно было поднять позже. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64');
  const actual = await derive(password, Buffer.from(salt, 'base64'), { N: Number(n), r: Number(r), p: Number(p) });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Хеш для сравнения, когда пользователь не найден: проверка занимает столько же времени,
 * и по задержке ответа нельзя узнать, зарегистрирован ли email.
 */
export const DUMMY_PASSWORD_HASH = `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(KEY_LEN).toString('base64')}`;
