/**
 * Нормализация телефона к E.164. Номера без «+» и «00»: 9 цифр считаются польскими (+48),
 * 11 цифр с префиксом 48 тоже. Все остальные международные номера должны быть с «+» или «00».
 * Возвращает null, если номер не похож на корректный.
 */
export function normalizePhone(input: string): string | null {
  const stripped = input.trim().replace(/[\s\-().]/g, '');
  if (stripped === '') return null;

  let candidate: string;
  if (stripped.startsWith('+')) {
    candidate = stripped;
  } else if (stripped.startsWith('00')) {
    candidate = '+' + stripped.slice(2);
  } else if (/^\d{9}$/.test(stripped)) {
    candidate = '+48' + stripped;
  } else if (/^48\d{9}$/.test(stripped)) {
    candidate = '+' + stripped;
  } else {
    return null;
  }

  return /^\+[1-9]\d{7,14}$/.test(candidate) ? candidate : null;
}
