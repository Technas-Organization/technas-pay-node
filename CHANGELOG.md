# Changelog

## 0.9.1 — 2026-11-14

`toAppJson(payment)` : la vue sans secret qu'un backend renvoie à son app (contrat de `technas_pay_flutter`). Exemple Express : routes `POST /technas-pay/payments` et `GET /technas-pay/payments/:id`.

## 0.9.0 — 2026-11-14

Cœur sans framework extrait de `@technas/pay-next` 0.8.0, même surface et mêmes règles. Ajouts :
- `handleWebhook(corpsBrut, signature, fonctions)` → `{ status, body, event }`, pour tout framework ;
- `nodeHandler(fonctions)` : route `(req, res, next)` pour Express, Connect, NestJS, `node:http` ; refuse un corps déjà parsé en JSON avec une erreur claire ;
- `createTestWebhookPayload` → `{ body, headers }` (supertest, `fastify.inject`) ;
- `retryReference(orderId, tentative)` ;
- option `requestInit` (ex. `{ cache: "no-store" }` sous Next.js), qui ne peut écraser ni méthode ni en-têtes ;
- `browser` et `react-native` résolvent vers un module qui casse à l'import : le secret ne peut pas partir dans une app.
