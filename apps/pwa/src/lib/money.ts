/** Сумма в злотых из поля ввода: запятая или точка, до двух знаков, больше нуля. null — не сумма. */
export function parseAmount(raw: string): number | null {
  const text = raw.trim().replace(',', '.');
  if (!/^\d+(\.\d{1,2})?$/.test(text)) return null;
  const n = Number(text);
  return n > 0 ? n : null;
}
