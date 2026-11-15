# Changelog

## 0.11.1 — 2026-11-15

- Remboursement par carte : `kind: "card"` (type `RefundKind = "payout" | "external" | "card"`). Un `"stripe"` encore renvoyé par l'API pendant la transition est lu comme `"card"` (`normalizeRefundKind`).
- Documentation : le prestataire carte n'est plus nommé que dans l'étape d'inscription ; tarif rappelé : carte 1 % (plus les frais de votre compte carte), mobile money 2 % (frais de l'opérateur payés par le client).

## 0.11.0 — 2026-11-15

Paiement par carte, repris de technas-pay-next#2 (qu'il remplace) :
- `askForPayment({ method: "card", currency })`, avec des décimales autorisées par carte ;
- `startCardOnboarding`, `getCardAccount`, `getCardDashboardLink` (tableau de bord du compte carte, identifiants du responsable) ;
- `card_account_not_ready` (`details.accountStatus`), `onCardAccountUpdated`, remboursement par carte (`kind`), `Payment.method`.

Routes de l'app : option `card` (`/methods` ouvre la carte si le compte est prêt), `POST /payments {method: "card"}` (références `orderId-card-N`), routes du marchand `GET /card/account` et `POST /card/onboarding` derrière `authorizeAdmin`. `toAppJson` porte `method`. Contrat v1 : 23 cas.

## 0.10.0 — 2026-11-15

`pay.appRoutes({ authorize, resolveOrder, returnUrl?, webhooks? })` : les routes toutes faites que lit `technas_pay_flutter` (`GET /methods`, `POST /payments`, `GET /payments/{id}`, `POST /webhook`), avec des adaptateurs `.node` (Express, Nest, node:http), `.fetchHandler`/`.nextHandlers` (Next.js, Hono, Bun) et `.handle` (sans framework). Essais expirés sautés automatiquement, propriété de la commande vérifiée à chaque lecture, montant jamais pris de la requête. Contrat partagé `contract/app-contract.v1.json` (13 cas).

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
