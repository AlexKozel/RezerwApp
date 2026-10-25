import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { emptyForm, staffDiff, toForm, toPayload, type ApiService } from '../src/lib/service-form';

const api: ApiService = {
  id: 's1',
  name: { pl: 'Manicure', en: 'Manicure EN' },
  depositMode: 'fixed',
  depositValue: 30,
  depositScope: 'new_clients',
  prepaymentMethod: 'manual_blik',
  requiresManualConfirm: false,
  cancelPolicyId: null,
  costPrice: 12.5,
  active: true,
  variants: [{ id: 'v1', name: { pl: 'Krótkie' }, durationMin: 60, bufferMin: 10, price: 120, active: true }],
  staff: [{ staffId: 'a' }],
};

describe('форма услуги', () => {
  test('из API в форму и обратно без потерь', () => {
    const { payload, errors } = toPayload(toForm(api));
    assert.deepEqual(errors, {});
    assert.deepEqual(payload!.service, {
      name: { pl: 'Manicure', en: 'Manicure EN' },
      requiresManualConfirm: false,
      prepaymentMethod: 'manual_blik',
      depositMode: 'fixed',
      depositValue: 30,
      depositScope: 'new_clients',
      costPrice: 12.5,
      active: true,
    });
    assert.deepEqual(payload!.variants, [{ id: 'v1', name: { pl: 'Krótkie' }, durationMin: 60, bufferMin: 10, price: 120, active: true }]);
  });

  test('обязательные поля и запятая в цене', () => {
    const f = emptyForm(['a']);
    assert.deepEqual(Object.keys(toPayload(f).errors).sort(), ['name', 'v0.price']);
    f.name.pl = 'Pedicure';
    f.variants[0]!.price = '99,50';
    const { payload } = toPayload(f);
    assert.equal(payload!.variants[0]!.price, 99.5);
    assert.equal(payload!.service.prepaymentMethod, 'none');
  });

  test('оплата: выше 30% предупреждение, выше 50% нельзя (D-014), против каждого варианта', () => {
    const f = toForm(api);
    f.variants.push({ name: 'Mini', durationMin: '30', bufferMin: '0', price: '50', active: true });
    f.feeValue = '20';
    assert.equal(toPayload(f).feeWarning, true, '20 zł от 50 zł = 40%');
    f.feeValue = '30';
    assert.equal(toPayload(f).errors.fee, 'pwa.cat.fee_cap', '30 zł от 50 zł = 60%');
    f.feeMode = 'percent';
    f.feeValue = '25';
    assert.deepEqual([toPayload(f).errors.fee, toPayload(f).feeWarning], [undefined, false]);
  });

  test('хотя бы один активный вариант', () => {
    const f = toForm(api);
    f.variants[0]!.active = false;
    assert.equal(toPayload(f).errors.variants, 'pwa.cat.variants');
  });

  test('назначения специалистов', () => {
    assert.deepEqual(staffDiff(['a', 'b'], ['b', 'c']), { add: ['c'], remove: ['a'] });
  });
});
