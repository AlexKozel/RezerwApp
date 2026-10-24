"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DEFAULT_LOCALE = exports.LOCALES = void 0;
exports.isLocale = isLocale;
/** Языки продукта (D-036). Юридически приоритетная версия текстов: польская. */
exports.LOCALES = ['pl', 'uk', 'ru', 'en'];
exports.DEFAULT_LOCALE = 'pl';
function isLocale(value) {
    return typeof value === 'string' && exports.LOCALES.includes(value);
}
