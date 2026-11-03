import { formatCents } from './currency.js';

/** Total price of the cart in cents. */
export function cartTotal(items) {
  return items.reduce((sum, item) => sum + item.priceCents, 0);
}

export function receiptLine(items) {
  return `Total: ${formatCents(cartTotal(items))}`;
}
