"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const locale_1 = require("../src/locale");
const i18n_1 = require("../src/i18n");
const keys = Object.keys(i18n_1.messages.pl);
(0, node_test_1.describe)('i18n PL/UK/RU/EN', () => {
    (0, node_test_1.test)('во всех локалях одинаковый набор ключей', () => {
        for (const locale of locale_1.LOCALES) {
            strict_1.default.deepEqual(Object.keys(i18n_1.messages[locale]).sort(), [...keys].sort(), locale);
        }
    });
    (0, node_test_1.test)('плейсхолдеры совпадают во всех локалях', () => {
        for (const key of keys) {
            const expected = (0, i18n_1.placeholdersOf)(i18n_1.messages.pl[key]);
            for (const locale of locale_1.LOCALES) {
                strict_1.default.deepEqual((0, i18n_1.placeholdersOf)(i18n_1.messages[locale][key]), expected, `${key} (${locale})`);
            }
        }
    });
    (0, node_test_1.test)('сообщения не пустые и без лишних пробелов по краям', () => {
        for (const locale of locale_1.LOCALES) {
            for (const key of keys) {
                const text = i18n_1.messages[locale][key];
                strict_1.default.ok(text.length > 0, `${key} (${locale}) пусто`);
                strict_1.default.equal(text, text.trim(), `${key} (${locale}) пробелы по краям`);
            }
        }
    });
    (0, node_test_1.test)('слово «zadatek» (и русское/украинское «задаток») в интерфейсе не используется (D-011)', () => {
        for (const locale of locale_1.LOCALES) {
            for (const key of keys) {
                strict_1.default.doesNotMatch(i18n_1.messages[locale][key], /zadat|задат/i, `${key} (${locale})`);
            }
        }
    });
    (0, node_test_1.test)('термин резервационной оплаты по-польски', () => {
        strict_1.default.equal((0, i18n_1.t)('pl', 'booking.fee.label'), 'Opłata rezerwacyjna');
    });
    (0, node_test_1.test)('подстановка параметров', () => {
        strict_1.default.equal((0, i18n_1.t)('en', 'booking.fee.instruction', { amount: 30, phone: '+48 500 000 000', code: 'A7K2' }), 'To confirm your booking, send 30 PLN via BLIK to +48 500 000 000. Put this code in the comment: A7K2.');
        strict_1.default.match((0, i18n_1.t)('ru', 'booking.cancel.free_until', { hours: 24 }), /24 ч/);
    });
    (0, node_test_1.test)('отсутствующий параметр это ошибка, а не сырой шаблон', () => {
        strict_1.default.throws(() => (0, i18n_1.t)('pl', 'booking.cancel.free_until'), /missing param "hours"/);
    });
    (0, node_test_1.test)('isLocale', () => {
        strict_1.default.equal((0, locale_1.isLocale)('uk'), true);
        strict_1.default.equal((0, locale_1.isLocale)('de'), false);
        strict_1.default.equal((0, locale_1.isLocale)(undefined), false);
    });
});
