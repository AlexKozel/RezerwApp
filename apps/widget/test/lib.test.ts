import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { errorMessage } from '../lib/errors';
import { addDays, formatCountdown, formatMoney, formatTime, groupByDay, localDay, pickText } from '../lib/format';
import { pickLocale } from '../lib/locale';
import { parseMarkdown } from '../lib/markdown';

const WAW = 'Europe/Warsaw';

describe('язык страницы', () => {
  test('?lang важнее браузера, затем Accept-Language, затем польский', () => {
    assert.equal(pickLocale('uk', 'pl-PL,pl;q=0.9'), 'uk');
    assert.equal(pickLocale(['ru', 'en'], null), 'ru');
    assert.equal(pickLocale('de', 'uk-UA,uk;q=0.9,en;q=0.8'), 'uk');
    assert.equal(pickLocale(undefined, 'de-DE,fr;q=0.8'), 'pl');
    assert.equal(pickLocale(undefined, null), 'pl');
  });
});

describe('время в поясе Account, а не браузера', () => {
  test('слоты группируются по местным дням Варшавы', () => {
    // 22:30 UTC 4 марта = 23:30 в Варшаве (4 марта); 23:30 UTC = 00:30 5 марта.
    const groups = groupByDay(['2030-03-04T23:30:00Z', '2030-03-04T22:30:00Z', '2030-03-05T08:00:00Z'], WAW);
    assert.deepEqual(groups.map((g) => [g.day, g.slots.length]), [['2030-03-04', 1], ['2030-03-05', 2]]);
    assert.equal(localDay(new Date('2030-07-01T22:30:00Z'), WAW), '2030-07-02');
    assert.equal(formatTime(new Date('2030-07-01T07:00:00Z'), WAW, 'pl'), '09:00');
  });

  test('даты, деньги, таймер, тексты', () => {
    assert.equal(addDays('2030-12-31', 1), '2031-01-01');
    assert.equal(formatMoney(30, 'pl'), '30');
    assert.equal(formatMoney(30.5, 'pl'), '30,50');
    assert.equal(formatCountdown(3_909_000), '1:05:09');
    assert.equal(formatCountdown(299_000), '4:59');
    assert.equal(formatCountdown(-5), '0:00');
    assert.equal(pickText({ pl: 'Manicure', uk: 'Манікюр' }, 'uk'), 'Манікюр');
    assert.equal(pickText({ pl: 'Manicure' }, 'en'), 'Manicure');
    assert.equal(pickText({}, 'en'), '');
  });
});

describe('сообщения об ошибках API', () => {
  test('blacklist показывается нейтрально, неизвестный код как общая ошибка', () => {
    assert.equal(errorMessage('NO_FREE_SLOTS', 'pl'), 'Brak wolnych terminów.');
    assert.equal(errorMessage('SLOT_NOT_AVAILABLE', 'en'), 'That time was just taken. Please choose another.');
    assert.equal(errorMessage('SOMETHING_NEW', 'ru'), 'Что-то пошло не так. Попробуйте ещё раз.');
    assert.equal(errorMessage(undefined, 'uk'), 'Щось пішло не так. Спробуйте ще раз.');
  });
});

describe('разметка юридических текстов', () => {
  test('заголовки, цитаты, абзацы; HTML остаётся текстом', () => {
    const blocks = parseMarkdown('# [PROJEKT] Regulamin\r\n\r\n> Tekst zastępczy\n> druga linia\n\nAkapit <script>alert(1)</script>\n\n## Sekcja');
    assert.deepEqual(blocks, [
      { kind: 'h1', text: '[PROJEKT] Regulamin' },
      { kind: 'quote', text: 'Tekst zastępczy\ndruga linia' },
      { kind: 'p', text: 'Akapit <script>alert(1)</script>' },
      { kind: 'h2', text: 'Sekcja' },
    ]);
  });
});
