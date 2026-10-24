import { ValidationError } from '../errors';

/**
 * Разбор тела и параметров запроса без внешних библиотек. Ошибки по всем полям собираются вместе
 * и отдаются одним ValidationError, чтобы форма могла подсветить все поля сразу.
 */
export class Input {
  private readonly errors: Record<string, string> = {};
  private readonly source: Record<string, unknown>;
  private readonly children: Array<[string, Input]> = [];

  constructor(raw: unknown) {
    this.source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    if (this.source !== raw) this.errors._ = 'expected an object';
  }

  private fail(key: string, reason: string): undefined {
    this.errors[key] ??= reason;
    return undefined;
  }

  has(key: string): boolean {
    return this.source[key] !== undefined && this.source[key] !== null;
  }

  string(key: string, opts: { min?: number; max?: number; pattern?: RegExp } = {}): string {
    return this.optString(key, opts) ?? (this.has(key) ? '' : (this.fail(key, 'required') ?? ''));
  }

  optString(key: string, { min = 1, max = 200, pattern }: { min?: number; max?: number; pattern?: RegExp } = {}): string | undefined {
    if (!this.has(key)) return undefined;
    const value = this.source[key];
    if (typeof value !== 'string') return this.fail(key, 'expected a string');
    const trimmed = value.trim();
    if (trimmed.length < min) return this.fail(key, `at least ${min} characters`);
    if (trimmed.length > max) return this.fail(key, `at most ${max} characters`);
    if (pattern && !pattern.test(trimmed)) return this.fail(key, 'invalid format');
    return trimmed;
  }

  int(key: string, opts: { min: number; max: number }): number {
    return this.optInt(key, opts) ?? (this.has(key) ? 0 : (this.fail(key, 'required') ?? 0));
  }

  optInt(key: string, { min, max }: { min: number; max: number }): number | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.source[key];
    const value = typeof raw === 'string' && /^-?\d+$/.test(raw) ? Number(raw) : raw;
    if (typeof value !== 'number' || !Number.isInteger(value)) return this.fail(key, 'expected an integer');
    if (value < min || value > max) return this.fail(key, `must be between ${min} and ${max}`);
    return value;
  }

  /** Денежная сумма: число или строка с не более чем двумя знаками после точки. */
  money(key: string, { max = 1_000_000 }: { max?: number } = {}): number {
    if (!this.has(key)) return this.fail(key, 'required') ?? 0;
    const raw = this.source[key];
    const text = typeof raw === 'number' ? String(raw) : raw;
    if (typeof text !== 'string' || !/^\d+(\.\d{1,2})?$/.test(text)) return this.fail(key, 'expected an amount') ?? 0;
    const value = Number(text);
    if (value > max) return this.fail(key, `at most ${max}`) ?? 0;
    return value;
  }

  bool(key: string): boolean {
    const value = this.source[key];
    if (typeof value !== 'boolean') return this.fail(key, 'expected true or false') ?? false;
    return value;
  }

  optBool(key: string): boolean | undefined {
    return this.has(key) ? this.bool(key) : undefined;
  }

  uuid(key: string): string {
    return this.string(key, { pattern: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, max: 36 });
  }

  optUuid(key: string): string | undefined {
    return this.has(key) ? this.uuid(key) : undefined;
  }

  oneOf<T extends string>(key: string, values: readonly T[]): T {
    const value = this.string(key, { max: 50 });
    if (value !== '' && !values.includes(value as T)) this.fail(key, `one of: ${values.join(', ')}`);
    return value as T;
  }

  optOneOf<T extends string>(key: string, values: readonly T[]): T | undefined {
    return this.has(key) ? this.oneOf(key, values) : undefined;
  }

  /** Календарная дата YYYY-MM-DD (локальная дата Account, без времени). */
  date(key: string): string {
    const value = this.string(key, { max: 10, pattern: /^\d{4}-\d{2}-\d{2}$/ });
    if (value !== '' && !isCalendarDate(value)) this.fail(key, 'not a calendar date');
    return value;
  }

  /** Время суток HH:MM → минуты от полуночи (24:00 допустимо как конец дня). */
  timeOfDay(key: string): number {
    const value = this.string(key, { max: 5, pattern: /^\d{2}:\d{2}$/ });
    if (value === '') return 0;
    const minutes = Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
    if (Number(value.slice(3)) > 59 || minutes > 24 * 60) return this.fail(key, 'not a time of day') ?? 0;
    return minutes;
  }

  /** Момент времени ISO 8601 с указанием зоны (Z или ±HH:MM). */
  instant(key: string): Date {
    const value = this.string(key, { max: 40, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/ });
    const date = new Date(value);
    if (value !== '' && Number.isNaN(date.getTime())) this.fail(key, 'not a valid instant');
    return date;
  }

  /** Объект «язык → текст» для name_i18n. */
  i18nText(key: string, { required = true, max = 200 } = {}): Record<string, string> {
    if (!this.has(key)) return required ? (this.fail(key, 'required') ?? {}) : {};
    const value = this.source[key];
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return this.fail(key, 'expected an object') ?? {};
    const result: Record<string, string> = {};
    for (const [lang, text] of Object.entries(value)) {
      if (!['pl', 'uk', 'ru', 'en'].includes(lang)) return this.fail(key, `unknown language ${lang}`) ?? {};
      if (typeof text !== 'string' || text.trim() === '' || text.length > max) return this.fail(key, `invalid text for ${lang}`) ?? {};
      result[lang] = text.trim();
    }
    if (required && Object.keys(result).length === 0) return this.fail(key, 'at least one language') ?? {};
    return result;
  }

  list(key: string, { max = 50 } = {}): Input[] {
    const value = this.source[key];
    if (!Array.isArray(value)) return this.fail(key, 'expected a list') ?? [];
    if (value.length > max) return this.fail(key, `at most ${max} items`) ?? [];
    return value.map((item, i) => {
      const child = new Input(item);
      this.children.push([`${key}.${i}`, child]);
      return child;
    });
  }

  /** Добавляет ошибку, найденную проверкой уровнем выше (например, пересечение интервалов). */
  reject(key: string, reason: string): void {
    this.fail(key, reason);
  }

  /** Бросает ValidationError, если были ошибки. Вызывать после чтения всех полей. */
  done(): void {
    const errors = this.collect();
    if (Object.keys(errors).length > 0) throw new ValidationError(errors);
  }

  private collect(): Record<string, string> {
    const errors = { ...this.errors };
    for (const [prefix, child] of this.children) {
      for (const [k, v] of Object.entries(child.collect())) errors[`${prefix}.${k}`] ??= v;
    }
    return errors;
  }
}

export function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
