/**
 * День рождения клиента: только день и месяц, формат "MM-DD" (D-065). Год не хранится (RODO: минимизация).
 * 29 февраля допустимо; в невисокосный год такой день рождения отмечается 28 февраля.
 */
export interface Birthday {
  month: number;
  day: number;
}

const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

export function isValidBirthday(month: number, day: number): boolean {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= DAYS_IN_MONTH[month - 1]!;
}

export function parseBirthday(value: string): Birthday | null {
  const m = /^(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const birthday = { month: Number(m[1]), day: Number(m[2]) };
  return isValidBirthday(birthday.month, birthday.day) ? birthday : null;
}

export function formatBirthdayValue(b: Birthday): string {
  return `${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}`;
}

export function daysInBirthMonth(month: number): number {
  return DAYS_IN_MONTH[month - 1] ?? 31;
}
