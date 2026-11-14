// Ce que le cœur ajoute à pay-next : handleWebhook, nodeHandler (Express, node:http, Nest),
// createTestWebhookPayload, retryReference, requestInit — et un vrai serveur HTTP de bout en bout.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { canRetry, createTechnasPay, retryReference, TechnasPayError } from "../dist/index.js";

const API_KEY = "pk_abc-DEF_123";
const WEBHOOK_SECRET = "ws_webhook-secret_456";
const SECRET = `tps_test_${API_KEY}.${WEBHOOK_SECRET}`;

/** Démarre un serveur node:http et rend son adresse ; `close()` l'arrête. */
async function listen(handler) {
  const server = createServer(handler);
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/** Faux serveur de la passerelle : une référence = un essai, auth par en-tête, page de test. */
function fakeGateway() {
  const payments = new Map();
  const seen = [];
  const handler = async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const url = new URL(req.url, "http://x");
    const test = /^\/test-checkout\/([^/]+)\/(completed|failed|expired)$/.exec(url.pathname);
    if (test) {
      const p = payments.get(test[1]);
      if (!p) return send(404, {});
      p.status = test[2];
      if (test[2] === "expired") p.checkout_url = null;
      if (test[2] === "completed") {
        res.writeHead(303, { location: "https://partenaire.test/merci" });
        return res.end();
      }
      return send(200, {});
    }
    if (req.headers.authorization !== `Bearer ${API_KEY}`) return send(401, { code: "invalid_api_key" });
    if (req.method === "POST" && url.pathname === "/v1/payments") {
      const body = JSON.parse(raw);
      const existing = [...payments.values()].find((p) => p.reference === body.reference);
      if (existing?.status === "expired") return send(409, { code: "payment_expired", message: "essai expiré" });
      if (existing && existing.amount !== body.amount) return send(409, { code: "reference_conflict", message: "m" });
      if (existing) return send(200, existing);
      const id = `pay_${payments.size + 1}`;
      const p = { id, reference: body.reference, amount: body.amount, currency: body.currency ?? null, commission: 100, net_amount: body.amount - 100, status: "pending", checkout_url: `/test-checkout/${id}`, metadata: {}, test_mode: true, created_at: "x" };
      payments.set(id, p);
      return send(201, p);
    }
    const one = /^\/v1\/payments\/([^/]+)$/.exec(url.pathname);
    if (req.method === "GET" && one) return payments.has(one[1]) ? send(200, payments.get(one[1])) : send(404, { code: "payment_not_found" });
    return send(404, { code: "not_found" });
  };
  return { handler, seen, payments };
}

test("de bout en bout contre un faux serveur HTTP : une référence = un essai", async () => {
  const gw = fakeGateway();
  const server = await listen(gw.handler);
  try {
    const pay = createTechnasPay({ secret: SECRET, baseUrl: server.url });
    const input = { amount: 5000, reference: retryReference("CMD-42", 1), customer: { email: "a@b.co", name: "A" }, returnUrl: "https://p.test" };
    const first = await pay.askForPayment(input);
    assert.equal((await pay.askForPayment(input)).id, first.id);
    await assert.rejects(pay.askForPayment({ ...input, amount: 9 }), (e) => e.code === "reference_conflict");
    assert.equal((await pay.simulateTestPayment(first.id, "failed")).status, "failed");
    const expired = await pay.simulateTestPayment(first.id, "expired");
    assert.ok(canRetry(expired) && expired.checkoutUrl === null);
    await assert.rejects(pay.askForPayment(input), (e) => e.code === "payment_expired" && !e.retryable);
    const second = await pay.askForPayment({ ...input, reference: retryReference("CMD-42", 2) });
    assert.notEqual(second.id, first.id);
    // Le secret ne voyage que dans l'en-tête, jamais dans une URL ni un corps.
    for (const r of gw.seen) {
      assert.ok(!r.url.includes(API_KEY) && !r.url.includes(WEBHOOK_SECRET));
      assert.ok(!r.body.includes(WEBHOOK_SECRET) && !r.body.includes("tps_test_"));
    }
    // Le 303 de la page de test n'est pas suivi.
    assert.equal((await pay.simulateTestPayment(second.id, "completed")).status, "completed");
  } finally {
    await server.close();
  }
});

test("retryReference compose orderId-tentative et refuse une tentative invalide", () => {
  assert.equal(retryReference("CMD-42", 2), "CMD-42-2");
  assert.equal(retryReference(42, 1), "42-1");
  assert.throws(() => retryReference("x", 0), (e) => e instanceof TechnasPayError && e.code === "invalid_request");
});

test("requestInit est ajouté à chaque appel, sans écraser méthode ni en-têtes", async () => {
  let init;
  const pay = createTechnasPay({
    secret: SECRET,
    requestInit: { cache: "no-store", method: "DELETE", headers: { Authorization: "volé" } },
    fetch: async (_u, i) => { init = i; return Response.json([]); },
  });
  await pay.getBalance();
  assert.equal(init.cache, "no-store");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Authorization, `Bearer ${API_KEY}`);
});

test("handleWebhook rend le statut et le corps, sans framework", async () => {
  const pay = createTechnasPay({ secret: SECRET });
  const { body, headers } = await pay.createTestWebhookPayload("payment.completed", { reference: "r-1", amount: 5000, currency: "XOF", commission: 100 });
  let got;
  const ok = await pay.handleWebhook(body, headers["X-Technas-Payment-Signature"] ?? headers["x-technas-payment-signature"], { onCompleted: (e) => { got = e; } });
  assert.equal(ok.status, 200);
  assert.equal(got.payment.netAmount, 4900);
  const bytes = await pay.handleWebhook(new TextEncoder().encode(body), Object.values(headers)[1], {});
  assert.equal(bytes.status, 200);
  const bad = await pay.handleWebhook(body, "t=1,s=00", { onCompleted: () => assert.fail() });
  assert.deepEqual([bad.status, bad.body], [400, { error: "invalid_signature" }]);
});

test("nodeHandler sur un vrai serveur node:http : 200, 400, et 500 si votre fonction échoue", async () => {
  const pay = createTechnasPay({ secret: SECRET });
  let calls = 0;
  const route = pay.nodeHandler({ onCompleted: (e) => { calls++; if (e.payment.reference === "boom-1") throw new Error("base en panne"); } });
  const server = await listen((req, res) => route(req, res));
  try {
    const hook = await pay.createTestWebhookPayload("payment.completed", { reference: "r-1", amount: 5000, currency: "XOF" });
    const ok = await fetch(`${server.url}/api/technas-pay`, { method: "POST", body: hook.body, headers: hook.headers });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { received: true });
    const bad = await fetch(`${server.url}/api/technas-pay`, { method: "POST", body: hook.body.replace("5000", "9"), headers: hook.headers });
    assert.equal(bad.status, 400);
    const boom = await pay.createTestWebhookPayload("payment.completed", { reference: "boom-1", amount: 1, currency: "XOF" });
    const failed = await fetch(`${server.url}/api/technas-pay`, { method: "POST", body: boom.body, headers: boom.headers });
    assert.equal(failed.status, 500);
    assert.equal(calls, 2);
  } finally {
    await server.close();
  }
});

test("nodeHandler façon Express : corps brut (express.raw), rawBody (Nest), next(erreur)", async () => {
  const pay = createTechnasPay({ secret: SECRET });
  const hook = await pay.createTestWebhookPayload("payment.expired", { reference: "r-1", amount: 5000, currency: "XOF" });
  const lower = Object.fromEntries(Object.entries(hook.headers).map(([k, v]) => [k.toLowerCase(), v]));
  const res = () => ({ statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } });
  const empty = { async *[Symbol.asyncIterator]() {} };
  let expired = 0;
  const route = pay.nodeHandler({ onExpired: () => { expired++; } });

  const r1 = res();
  await route({ ...empty, headers: lower, body: Buffer.from(hook.body) }, r1);
  assert.equal(r1.statusCode, 200);

  const r2 = res();
  await route({ ...empty, headers: lower, body: { deja: "parsé" }, rawBody: Buffer.from(hook.body) }, r2);
  assert.equal(r2.statusCode, 200);
  assert.equal(expired, 2);

  // express.json() est passé avant : erreur claire, transmise à next, jamais un 200.
  let forwarded;
  const r3 = res();
  await route({ ...empty, headers: lower, body: JSON.parse(hook.body) }, r3, (e) => { forwarded = e; });
  assert.match(forwarded.message, /express\.raw/);
  assert.equal(r3.statusCode, 0);
});

test("webhookHandler reste utilisable détaché de l'objet", async () => {
  const { webhookHandler, createTestWebhook } = createTechnasPay({ secret: SECRET });
  const response = await webhookHandler({})(await createTestWebhook("payment.failed", { reference: "r", amount: 1, currency: "XOF" }));
  assert.equal(response.status, 200);
});

test("sans crypto global (Node 18) : node:crypto prend le relais", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  Object.defineProperty(globalThis, "crypto", { value: undefined, configurable: true, writable: true });
  try {
    const pay = createTechnasPay({ secret: SECRET });
    const hook = await pay.createTestWebhookPayload("payment.completed", { reference: "r-1", amount: 1, currency: "XOF" });
    const result = await pay.handleWebhook(hook.body, hook.headers["X-Technas-Payment-Signature"] ?? Object.values(hook.headers)[1], {});
    assert.equal(result.status, 200);
  } finally {
    if (original) Object.defineProperty(globalThis, "crypto", original);
    else delete globalThis.crypto; // Node 18 : pas de crypto global au départ
  }
});
