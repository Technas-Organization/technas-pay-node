// Rejoue contract/app-contract.v1.json : le même fichier que le client Flutter et les SDK
// Python et Dart rejouent. Puis les adaptateurs Express (node) et fetch (Next, Hono).
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { test } from "node:test";
import { createTechnasPay } from "../dist/index.js";

const contract = JSON.parse(readFileSync(new URL("../contract/app-contract.v1.json", import.meta.url), "utf8"));
const WEBHOOK_SECRET = "ws_secret";
const SECRET = `tps_test_pk_abc.${WEBHOOK_SECRET}`;

/** Un client dont `fetch` rend les réponses du cas, dans l'ordre, et note les appels. */
function payFor(gateway) {
  const calls = [];
  const queue = [...gateway];
  const pay = createTechnasPay({
    secret: SECRET,
    baseUrl: "https://gw.test",
    fetch: async (url, init) => {
      const u = new URL(url);
      calls.push({ method: init.method, path: u.pathname, query: Object.fromEntries(u.searchParams), body: init.body ? JSON.parse(init.body) : undefined });
      const next = queue.shift();
      if (!next) throw new Error("appel imprévu à la passerelle");
      return next.body === null ? new Response("<html>panne</html>", { status: next.status }) : Response.json(next.body, { status: next.status });
    },
  });
  return { pay, calls };
}

function routesFor(c, pay, webhooks) {
  return pay.appRoutes({
    authorize: () => c.user,
    resolveOrder: (orderId, user) => (user === c.user ? c.orders[orderId] ?? null : null),
    returnUrl: "https://app.test/retour",
    webhooks,
    ...(c.options ?? {}),
    ...("admin" in c ? { authorizeAdmin: () => c.admin } : {}),
  });
}

/** Compare sans le texte libre `message`. */
function sansMessage(body) {
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const { message, ...rest } = body;
    return rest;
  }
  return body;
}

test("le contrat compte 32 cas", () => assert.equal(contract.cases.length, 32));

for (const c of contract.cases) {
  test(`contrat : ${c.name}`, async () => {
    const { pay, calls } = payFor(c.gateway);
    const r = await routesFor(c, pay).handle({
      method: c.request.method,
      path: c.request.path,
      query: c.request.query ?? {},
      headers: {},
      rawBody: c.request.body === undefined ? "" : JSON.stringify(c.request.body),
    });
    assert.equal(r.status, c.expect.status);
    assert.deepEqual(sansMessage(r.body), c.expect.body);
    assert.equal(calls.length, c.expect_gateway.length, "nombre d'appels à la passerelle");
    c.expect_gateway.forEach((e, i) => {
      assert.equal(calls[i].method, e.method);
      assert.equal(calls[i].path, e.path);
      for (const [k, v] of Object.entries(e.body_includes ?? {})) assert.deepEqual(calls[i].body[k], v, k);
      for (const [k, v] of Object.entries(e.query_includes ?? {})) assert.equal(calls[i].query[k], v, `?${k}`);
    });
    if (r.status >= 400) assert.equal(typeof r.body.message, "string");
  });
}

test("webhook : signé → vos fonctions ; mauvaise signature → 400", async () => {
  const { pay } = payFor([]);
  const paid = [];
  const routes = routesFor({ user: "u1", orders: {} }, pay, { onCompleted: (e) => paid.push(e.payment.reference) });
  const body = JSON.stringify({ id: "e1", type: "payment.completed", created_at: "x", data: { id: "p", reference: "42-1", status: "completed", amount: 1, currency: "XOF" } });
  const ts = Math.floor(Date.now() / 1000);
  const sig = `t=${ts},s=${createHmac("sha256", WEBHOOK_SECRET).update(`${ts}.${body}`).digest("hex")}`;
  const ok = await routes.handle({ method: "POST", path: "/webhook", query: {}, headers: { "x-technas-payment-signature": sig }, rawBody: body });
  assert.equal(ok.status, 200);
  assert.deepEqual(paid, ["42-1"]);
  const bad = await routes.handle({ method: "POST", path: "/webhook", query: {}, headers: { "x-technas-payment-signature": "t=1,s=00" }, rawBody: body });
  assert.equal(bad.status, 400);
  // Sans webhooks branchés, la route n'existe pas (rien d'acquitté en silence).
  const none = await routesFor({ user: "u1", orders: {} }, pay).handle({ method: "POST", path: "/webhook", query: {}, headers: {}, rawBody: body });
  assert.equal(none.status, 404);
});

test("adaptateur fetch (Next, Hono) : préfixe retiré, en-têtes passés à authorize", async () => {
  const c = contract.cases[0];
  const { pay } = payFor(c.gateway);
  let seen;
  const { POST } = pay
    .appRoutes({ authorize: (req) => { seen = req.headers.authorization; return "u1"; }, resolveOrder: (id) => c.orders[id] ?? null })
    .nextHandlers("/api/technas-pay");
  const res = await POST(new Request("https://app.test/api/technas-pay/payments", { method: "POST", body: JSON.stringify({ orderId: "42" }), headers: { Authorization: "Bearer jeton" } }));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).payment.reference, "42-1");
  assert.equal(seen, "Bearer jeton");
});

test("adaptateur node sur un vrai serveur (Express monte sous un préfixe et retire celui-ci)", async () => {
  const c = contract.cases.find((x) => x.request.path === "/methods");
  const { pay } = payFor([]);
  const routes = routesFor(c, pay);
  const server = createServer((req, res) => routes.node(req, res));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/methods?orderId=42`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), c.expect.body);
  } finally {
    server.close();
  }
});

test("exemple Express : les routes montées sous /api/technas-pay", async () => {
  const express = (await import("express")).default;
  const c = contract.cases[0];
  const { pay } = payFor(c.gateway);
  const app = express();
  app.use("/api/technas-pay", routesFor(c, pay).node);
  app.use(express.json());
  const server = app.listen(0);
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/technas-pay/payments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: "42" }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), c.expect.body);
  } finally {
    server.close();
  }
});

test("annuler : POST /payments/{id}/cancel servi par les adaptateurs fetch (Next) et node (Express)", async () => {
  const c = contract.cases.find((x) => x.request.method === "POST" && x.request.path === "/payments/pay_1/cancel" && x.expect.status === 200);
  // fetch / Next : POST est exporté par nextHandlers.
  {
    const { pay, calls } = payFor(c.gateway);
    const { POST } = routesFor(c, pay).nextHandlers("/api/technas-pay");
    const res = await POST(new Request("https://app.test/api/technas-pay/payments/pay_1/cancel", { method: "POST" }));
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), c.expect.body);
    assert.deepEqual(calls.map((x) => `${x.method} ${x.path}`), ["GET /v1/payments/pay_1", "POST /v1/payments/pay_1/cancel"]);
  }
  // Express, monté avant et après express.json() (corps vide ou {}).
  const express = (await import("express")).default;
  for (const body of [undefined, "{}"]) {
    const { pay, calls } = payFor(c.gateway);
    const app = express();
    app.use(express.json());
    app.use("/api/technas-pay", routesFor(c, pay).node);
    const server = app.listen(0);
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/technas-pay/payments/pay_1/cancel`, {
        method: "POST",
        ...(body ? { body, headers: { "content-type": "application/json" } } : {}),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), c.expect.body);
      assert.equal(calls.length, 2);
    } finally {
      server.close();
    }
  }
});

test("annuler : un identifiant invalide → 404 payment_not_found, sans appel à la passerelle", async () => {
  const c = { user: "u1", orders: {} };
  const { pay, calls } = payFor([]);
  for (const path of ["/payments/..%2Fbalance/cancel", "/payments/pay%201/cancel", "/payments/%E0%A4%A/cancel"]) {
    const r = await routesFor(c, pay).handle({ method: "POST", path, query: {}, headers: {}, rawBody: "" });
    assert.equal(r.status, 404, path);
    assert.equal(r.body.code, "payment_not_found");
  }
  assert.equal(calls.length, 0);
});
