import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { LOCALES, isLocale } from '../src/locale';
import { messages, placeholdersOf, t, type MessageKey } from '../src/i18n';

const keys = Object.keys(messages.pl) as MessageKey[];

describe('i18n PL/UK/RU/EN', () => {
  test('во всех локалях одинаковый набор ключей', () => {
    for (const locale of LOCALES) {
      assert.deepEqual(Object.keys(messages[locale]).sort(), [...keys].sort(), locale);
    }
  });

  test('плейсхолдеры совпадают во всех локалях', () => {
    for (const key of keys) {
      const expected = placeholdersOf(messages.pl[key]);
      for (const locale of LOCALES) {
        assert.deepEqual(placeholdersOf(messages[locale][key]), expected, `${key} (${locale})`);
      }
    }
  });

  test('сообщения не пустые и без лишних пробелов по краям', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        const text = messages[locale][key];
        assert.ok(text.length > 0, `${key} (${locale}) пусто`);
        assert.equal(text, text.trim(), `${key} (${locale}) пробелы по краям`);
      }
    }
  });

  test('слово «zadatek» (и русское/украинское «задаток») в интерфейсе не используется (D-011)', () => {
    for (const locale of LOCALES) {
      for (const key of keys) {
        assert.doesNotMatch(messages[locale][key], /zadat|задат/i, `${key} (${locale})`);
      }
    }
  });

  test('термин резервационной оплаты по-польски', () => {
    assert.equal(t('pl', 'booking.fee.label'), 'Opłata rezerwacyjna');
  });

  test('подстановка параметров', () => {
    assert.equal(
      t('en', 'booking.fee.instruction', { amount: 30, phone: '+48 500 000 000', code: 'A7K2' }),
      'To confirm your booking, send 30 PLN via BLIK to +48 500 000 000. Put this code in the comment: A7K2.',
    );
    assert.match(t('ru', 'booking.cancel.free_until', { hours: 24 }), /24 ч/);
  });

  test('отсутствующий параметр это ошибка, а не сырой шаблон', () => {
    assert.throws(() => t('pl', 'booking.cancel.free_until'), /missing param "hours"/);
  });

  test('isLocale', () => {
    assert.equal(isLocale('uk'), true);
    assert.equal(isLocale('de'), false);
    assert.equal(isLocale(undefined), false);
  });
});
