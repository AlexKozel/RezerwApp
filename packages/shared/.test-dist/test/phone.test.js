"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const strict_1 = __importDefault(require("node:assert/strict"));
const node_test_1 = require("node:test");
const phone_1 = require("../src/phone");
(0, node_test_1.describe)('normalizePhone', () => {
    (0, node_test_1.test)('польские номера без кода страны получают +48', () => {
        strict_1.default.equal((0, phone_1.normalizePhone)('500 100 200'), '+48500100200');
        strict_1.default.equal((0, phone_1.normalizePhone)('500-100-200'), '+48500100200');
        strict_1.default.equal((0, phone_1.normalizePhone)('(500) 100.200'), '+48500100200');
    });
    (0, node_test_1.test)('номер с кодом страны в разных записях сводится к одному виду', () => {
        const expected = '+48500100200';
        for (const input of ['+48 500 100 200', '0048500100200', '48500100200', ' +48500100200 ']) {
            strict_1.default.equal((0, phone_1.normalizePhone)(input), expected, input);
        }
    });
    (0, node_test_1.test)('международные номера принимаются только с + или 00', () => {
        strict_1.default.equal((0, phone_1.normalizePhone)('+380 50 123 4567'), '+380501234567');
        strict_1.default.equal((0, phone_1.normalizePhone)('00380501234567'), '+380501234567');
        strict_1.default.equal((0, phone_1.normalizePhone)('380501234567'), null);
    });
    (0, node_test_1.test)('мусор и слишком короткие или длинные номера отклоняются', () => {
        for (const input of ['', '   ', 'abc', '12345', '+48', '+0123456789', '+1234567890123456', '5001002']) {
            strict_1.default.equal((0, phone_1.normalizePhone)(input), null, input);
        }
    });
});
