import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { describe, test } from 'node:test';
import { newPasswordError, temporaryPassword } from '../src/lib/password';

const random = (b: Uint8Array) => webcrypto.getRandomValues(b);

describe('временный пароль', () => {
  test('формат xxxx-xxxx-xxxx без похожих символов, длина не меньше требования API', () => {
    for (let i = 0; i < 200; i += 1) {
      const p = temporaryPassword(random);
      assert.match(p, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
      assert.ok(p.length >= 10);
    }
  });

  test('разные пароли и равномерность: байты выше границы отбрасываются', () => {
    assert.equal(new Set(Array.from({ length: 100 }, () => temporaryPassword(random))).size, 100);
    // Только «плохие» байты, затем нули: результат из первого символа алфавита, без смещения.
    let call = 0;
    const biased = (b: Uint8Array) => b.fill(call++ === 0 ? 255 : 0);
    assert.equal(temporaryPassword(biased), 'aaaa-aaaa-aaaa');
  });
});

describe('проверка нового пароля', () => {
  test('длина, повтор, отличие от текущего', () => {
    assert.equal(newPasswordError('old password 1', 'short', 'short'), 'pwa.pwd.new');
    assert.equal(newPasswordError('old password 1', 'new password 1', 'new password 2'), 'pwa.pwd.mismatch');
    assert.equal(newPasswordError('same password', 'same password', 'same password'), 'pwa.pwd.same');
    assert.equal(newPasswordError('old password 1', 'new password 1', 'new password 1'), null);
  });
});
