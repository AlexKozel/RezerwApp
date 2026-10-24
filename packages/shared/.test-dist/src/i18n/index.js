"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.messages = void 0;
exports.t = t;
exports.placeholdersOf = placeholdersOf;
const en_1 = require("./en");
const pl_1 = require("./pl");
const ru_1 = require("./ru");
const uk_1 = require("./uk");
exports.messages = { pl: pl_1.pl, uk: uk_1.uk, ru: ru_1.ru, en: en_1.en };
/**
 * Возвращает сообщение с подстановкой {параметров}. Отсутствующий параметр это ошибка программиста,
 * поэтому бросаем исключение, а не показываем клиенту сырой шаблон.
 */
function t(locale, key, params = {}) {
    return exports.messages[locale][key].replace(/\{(\w+)\}/g, (_match, name) => {
        const value = params[name];
        if (value === undefined)
            throw new Error(`i18n: missing param "${name}" for key "${key}" (${locale})`);
        return String(value);
    });
}
function placeholdersOf(template) {
    return [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}
