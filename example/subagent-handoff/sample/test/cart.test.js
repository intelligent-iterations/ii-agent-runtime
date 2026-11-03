import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cartTotal, receiptLine } from '../src/cart.js';

test('cartTotal multiplies each price by its quantity', () => {
  assert.equal(cartTotal([{ priceCents: 250, quantity: 2 }, { priceCents: 100, quantity: 1 }]), 600);
});

test('receiptLine formats the total', () => {
  assert.equal(receiptLine([{ priceCents: 1999, quantity: 1 }]), 'Total: $19.99');
});
