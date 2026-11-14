// Les exemples tournent vraiment : un webhook de test signé arrive sur leur route.
import assert from "node:assert/strict";
import { test } from "node:test";

process.env.TECHNAS_PAY_SECRET = "tps_test_pk_abc.ws_secret";

test("exemple Express", async () => {
  const { app, pay, orders } = await import("../examples/express.mjs");
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/technas-pay`;
  try {
    const done = await pay.createTestWebhookPayload("payment.completed", { reference: "42-1", amount: 5000, currency: "XOF" });
    assert.equal((await fetch(url, { method: "POST", body: done.body, headers: done.headers })).status, 200);
    assert.equal(orders.get("42").paid, true);
    const expired = await pay.createTestWebhookPayload("payment.expired", { reference: "42-1", amount: 5000, currency: "XOF" });
    await fetch(url, { method: "POST", body: expired.body, headers: expired.headers });
    assert.equal(orders.get("42").attempt, 2);
    const bad = await fetch(url, { method: "POST", body: done.body, headers: { "content-type": "application/json" } });
    assert.equal(bad.status, 400);
  } finally {
    server.close();
  }
});

test("exemple Fastify", async () => {
  const { build, pay, paid } = await import("../examples/fastify.mjs");
  const app = build();
  const hook = await pay.createTestWebhookPayload("payment.completed", { reference: "7-1", amount: 5000, currency: "XOF" });
  const ok = await app.inject({ method: "POST", url: "/api/technas-pay", payload: hook.body, headers: hook.headers });
  assert.equal(ok.statusCode, 200);
  assert.ok(paid.has("7-1"));
  const bad = await app.inject({ method: "POST", url: "/api/technas-pay", payload: hook.body, headers: { "content-type": "application/json", "x-technas-payment-signature": "t=1,s=00" } });
  assert.equal(bad.statusCode, 400);
  await app.close();
});
