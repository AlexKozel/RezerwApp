/**
 * Текст ошибки для CLI. У ошибки соединения pg (AggregateError) message пустой, а причина в code
 * (ECONNREFUSED): без этого CLI завершался с кодом 1 и пустой строкой.
 */
export function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const code = (error as { code?: unknown }).code;
  const message = error.message || (typeof code === 'string' ? `${code}: is the database running and reachable?` : error.name);
  return typeof code === 'string' && error.message ? `${message} (${code})` : message;
}
