/** Cart pricing for the fake Acme Mini checkout. Amounts are whole rupees. */
export type LineItem = { sku: string; unitPrice: number; quantity: number };
export type Cart = { items: LineItem[]; couponPercent?: number };
export type Quote = { subtotal: number; discount: number; gst: number; total: number };

const GST_PERCENT = 18;

export function quote(cart: Cart): Quote {
  for (const item of cart.items) {
    if (!Number.isInteger(item.unitPrice) || item.unitPrice < 0) {
      throw new Error(`bad price for ${item.sku}`);
    }
    if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
      throw new Error(`bad quantity for ${item.sku}`);
    }
  }
  const percent = cart.couponPercent ?? 0;
  if (percent < 0 || percent > 100) throw new Error("bad coupon");

  const subtotal = cart.items.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
  const discount = Math.round((subtotal * percent) / 100);
  const taxable = subtotal - discount;
  const gst = Math.round((taxable * GST_PERCENT) / 100);
  return { subtotal, discount, gst, total: taxable + gst };
}
