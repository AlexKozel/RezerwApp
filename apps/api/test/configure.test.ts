import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { trustProxySetting } from '../src/http/configure';

describe('TRUST_PROXY (IP клиента для лимитов частоты)', () => {
  test('по умолчанию никому не доверяем; число хопов и loopback принимаются', () => {
    assert.equal(trustProxySetting(undefined), false);
    assert.equal(trustProxySetting(''), false);
    assert.equal(trustProxySetting('false'), false);
    assert.equal(trustProxySetting('1'), 1);
    assert.equal(trustProxySetting('loopback'), 'loopback');
  });

  test('«доверять всем» запрещено: иначе IP в лимитах подделывается заголовком', () => {
    assert.throws(() => trustProxySetting('true'), /would trust any X-Forwarded-For/);
  });
});
