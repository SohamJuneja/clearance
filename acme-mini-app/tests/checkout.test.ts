import assert from "node:assert/strict";
import { test } from "node:test";
import { signSession, verifySession } from "../src/auth/session.ts";
import { quote } from "../src/checkout.ts";

test("prices a cart with GST", () => {
  const result = quote({ items: [{ sku: "tee", unitPrice: 1000, quantity: 2 }] });
  assert.deepEqual(result, { subtotal: 2000, discount: 0, gst: 360, total: 2360 });
});

test("applies a coupon before tax", () => {
  const result = quote({
    items: [{ sku: "tee", unitPrice: 1000, quantity: 1 }],
    couponPercent: 10,
  });
  assert.deepEqual(result, { subtotal: 1000, discount: 100, gst: 162, total: 1062 });
});

test("refuses a bad cart", () => {
  assert.throws(() => quote({ items: [{ sku: "tee", unitPrice: -1, quantity: 1 }] }));
  assert.throws(() => quote({ items: [{ sku: "tee", unitPrice: 1, quantity: 0 }] }));
  assert.throws(() => quote({ items: [], couponPercent: 101 }));
});

test("verifies only a session it signed", () => {
  const token = signSession("cus_8812", "secret");
  assert.equal(verifySession(token, "secret"), "cus_8812");
  assert.equal(verifySession(token, "other"), null);
  assert.equal(verifySession("cus_1.deadbeef", "secret"), null);
  assert.equal(verifySession("nonsense", "secret"), null);
});
