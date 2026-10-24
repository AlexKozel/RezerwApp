import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, test } from 'node:test';
import { FieldCipher } from '../src/crypto/field-cipher';
import { EnvKeyProvider } from '../src/crypto/key-provider';
import { DUMMY_PASSWORD_HASH, hashPassword, verifyPassword } from '../src/crypto/password';
import { PhoneHasher } from '../src/crypto/phone-hash';
import { createTestDb, seedAccount, type TestDb } from './helpers/test-db';

describe('пароли (scrypt)', () => {
  test('верный пароль проходит, неверный нет, соль разная', async () => {
    const a = await hashPassword('correct horse battery');
    const b = await hashPassword('correct horse battery');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('scrypt$32768$8$1$'));
    assert.equal(await verifyPassword('correct horse battery', a), true);
    assert.equal(await verifyPassword('correct horse batterY', a), false);
  });

  test('повреждённый хеш и заглушка не совпадают ни с каким паролем', async () => {
    assert.equal(await verifyPassword('x', 'garbage'), false);
    assert.equal(await verifyPassword('', DUMMY_PASSWORD_HASH), false);
  });
});

describe('хеш телефона (HMAC, D-042)', () => {
  test('разные записи одного номера дают один хеш, другой pepper даёт другой', () => {
    const h = new PhoneHasher('pepper-1');
    const a = h.hashInput('500 100 200');
    const b = h.hashInput('+48 500-100-200');
    assert.ok(a && b);
    assert.equal(a.e164, '+48500100200');
    assert.deepEqual(a.hash, b.hash);
    assert.equal(a.hash.length, 32);
    assert.notDeepEqual(new PhoneHasher('pepper-2').hash('+48500100200'), a.hash);
    assert.equal(h.hashInput('abc'), null);
  });
});

describe('шифрование полей (envelope, ключ на Account)', () => {
  let db: TestDb;
  const provider = new EnvKeyProvider(randomBytes(32));

  before(async () => {
    db = await createTestDb('crypto');
  });
  after(async () => {
    await db.close();
  });

  test('шифротекст расшифровывается, в БД хранится только обёрнутый ключ', async () => {
    const s = await seedAccount(db.admin);
    const cipher = new FieldCipher(provider);
    const data = await db.app.withAccount(s.accountId, (c) => cipher.encrypt(c, s.accountId, '+48500100200'));
    assert.ok(!data.toString('latin1').includes('500100200'));
    const plain = await db.app.withAccount(s.accountId, (c) => new FieldCipher(provider).decrypt(c, s.accountId, data));
    assert.equal(plain, '+48500100200');
    const keys = await db.admin.query('SELECT provider, length(wrapped_key) AS n FROM account_keys WHERE account_id = $1', [s.accountId]);
    assert.deepEqual(keys.rows, [{ provider: 'env-v1', n: 12 + 16 + 32 }]);
  });

  test('у каждого Account свой ключ; шифротекст другого Account не расшифровать', async () => {
    const a = await seedAccount(db.admin);
    const b = await seedAccount(db.admin);
    const cipher = new FieldCipher(provider);
    const secret = await db.app.withAccount(a.accountId, (c) => cipher.encrypt(c, a.accountId, 'note'));
    await db.app.withAccount(b.accountId, (c) => cipher.encrypt(c, b.accountId, 'warm-up'));
    await assert.rejects(db.app.withAccount(b.accountId, (c) => new FieldCipher(provider).decrypt(c, b.accountId, secret)));
  });

  test('ключ чужого Account не виден, ключ нельзя изменить или удалить', async () => {
    const a = await seedAccount(db.admin);
    const b = await seedAccount(db.admin);
    await db.app.withAccount(a.accountId, (c) => new FieldCipher(provider).encrypt(c, a.accountId, 'x'));
    const seen = await db.app.withAccount(b.accountId, (c) => c.query('SELECT count(*)::int AS n FROM account_keys'));
    assert.equal(seen.rows[0].n, 0);
    await assert.rejects(db.app.withAccount(a.accountId, (c) => c.query('DELETE FROM account_keys')), /permission denied/);
    await assert.rejects(db.app.withAccount(a.accountId, (c) => c.query("UPDATE account_keys SET provider = 'x'")), /permission denied/);
  });

  test('параллельное первое шифрование создаёт один ключ', async () => {
    const s = await seedAccount(db.admin);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => db.app.withAccount(s.accountId, (c) => new FieldCipher(provider).encrypt(c, s.accountId, 'v'))),
    );
    assert.equal(results.length, 8);
    const keys = await db.admin.query('SELECT count(*)::int AS n FROM account_keys WHERE account_id = $1', [s.accountId]);
    assert.equal(keys.rows[0].n, 1);
    for (const r of results) {
      assert.equal(await db.app.withAccount(s.accountId, (c) => new FieldCipher(provider).decrypt(c, s.accountId, r)), 'v');
    }
  });

  test('другой мастер-ключ не разворачивает ключ данных', async () => {
    const s = await seedAccount(db.admin);
    await db.app.withAccount(s.accountId, (c) => new FieldCipher(provider).encrypt(c, s.accountId, 'x'));
    const foreign = new FieldCipher(new EnvKeyProvider(randomBytes(32)));
    await assert.rejects(db.app.withAccount(s.accountId, (c) => foreign.encrypt(c, s.accountId, 'y')));
  });
});
