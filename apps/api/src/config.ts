/** Настройки из окружения. Проверяются один раз при старте: лучше упасть сразу, чем с секретом-заглушкой в проде. */
export interface AppConfig {
  production: boolean;
  databaseUrl: string;
  redisUrl: string;
  /** Секрет HMAC для phone_hash (D-042). После появления реальных данных не меняется. */
  phoneHashPepper: string;
  /** Мастер-ключ (32 байта, base64) для обёртки ключей данных Account (D-042). */
  fieldMasterKey: Buffer;
  /** Тестовый OTP-код alpha (D-035). */
  alphaOtpCode: string;
  cookieSecure: boolean;
  /** Запускать фоновые задачи BullMQ в этом процессе (D-049). */
  workers: boolean;
  /** Адрес публичных страниц для ссылок в уведомлениях (страница специалиста, управление записью). */
  publicUrl: string;
}

const DEV_PLACEHOLDERS = new Set(['change-me', '']);
/** Ключ разработки из .env.example. */
const DEV_MASTER_KEY = 'cmV6ZXJ3YXBwLWRldi1vbmx5LW1hc3Rlci1rZXktMzI=';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (value === undefined || value === '') throw new Error(`${name} is not set`);
  return value;
}

function publicUrl(env: NodeJS.ProcessEnv, production: boolean): string {
  const raw = env.PUBLIC_URL ?? (production ? '' : `http://localhost:${env.PORT ?? 3000}`);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('PUBLIC_URL must be an absolute URL');
  }
  if (production && url.protocol !== 'https:') throw new Error('PUBLIC_URL must use https in production');
  return url.toString().replace(/\/$/, '');
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === 'production';

  const phoneHashPepper = required(env, 'PHONE_HASH_PEPPER');
  if (production && (DEV_PLACEHOLDERS.has(phoneHashPepper) || phoneHashPepper.length < 32)) {
    throw new Error('PHONE_HASH_PEPPER must be a real secret of at least 32 characters in production');
  }

  const masterKeyText = required(env, 'FIELD_MASTER_KEY');
  if (production && masterKeyText === DEV_MASTER_KEY) throw new Error('FIELD_MASTER_KEY must not be the development key in production');
  const fieldMasterKey = Buffer.from(masterKeyText, 'base64');
  if (fieldMasterKey.length !== 32) throw new Error('FIELD_MASTER_KEY must be 32 bytes encoded as base64');

  const alphaOtpCode = env.ALPHA_OTP_CODE ?? '0000';
  if (!/^\d{4,8}$/.test(alphaOtpCode)) throw new Error('ALPHA_OTP_CODE must be 4-8 digits');

  return {
    production,
    databaseUrl: required(env, 'DATABASE_URL'),
    redisUrl: required(env, 'REDIS_URL'),
    phoneHashPepper,
    fieldMasterKey,
    alphaOtpCode,
    cookieSecure: env.COOKIE_SECURE !== undefined ? env.COOKIE_SECURE === 'true' : production,
    workers: env.WORKERS !== 'false',
    publicUrl: publicUrl(env, production),
  };
}
