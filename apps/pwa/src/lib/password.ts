import type { MessageKey } from '@rezerwapp/shared';

/** Без похожих символов (0/O, 1/l/I): пароль диктуют голосом или переписывают с экрана. */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export const MIN_PASSWORD_LENGTH = 10;

/**
 * Временный пароль для приглашения сотрудника (D-061): 3 группы по 4 символа, ~59 бит из криптографического
 * генератора браузера. Сотрудник обязан сменить его при первом входе.
 */
export function temporaryPassword(random: (bytes: Uint8Array) => Uint8Array = (b) => crypto.getRandomValues(b)): string {
  const chars: string[] = [];
  // Отбраковка вместо остатка от деления: все символы равновероятны.
  const limit = 256 - (256 % ALPHABET.length);
  while (chars.length < 12) {
    for (const byte of random(new Uint8Array(16))) {
      if (byte < limit && chars.length < 12) chars.push(ALPHABET[byte % ALPHABET.length]!);
    }
  }
  return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Проверка формы смены пароля до запроса: та же длина, что в API (10), повтор и отличие от текущего. */
export function newPasswordError(current: string, next: string, repeat: string): MessageKey | null {
  if (next.length < MIN_PASSWORD_LENGTH) return 'pwa.pwd.new';
  if (next !== repeat) return 'pwa.pwd.mismatch';
  if (next === current) return 'pwa.pwd.same';
  return null;
}
