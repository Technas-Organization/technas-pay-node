# Changelog

## 0.19.0 — 2026-11-24

Un prix affiché fixe, et la grille des frais :
- `pay.displayPrice({ receive, country | countries, currency?, roundTo? })` (ou `getDisplayPrice`) : le plus petit prix rond qui vous laisse au moins `receive` sur chaque réseau ; `byCountry` (un prix par pays), `everywhere` (un prix valable partout), `worstNetwork`, `netByNetwork`. Le paiement se crée ensuite en `fees: "partner"` ;
- `pay.getRates(country?)` (ou `rates`) : par pays et par réseau, pourcentage, paliers, minimum, commission Technas, estimation des frais de l'opérateur, exemple à 1 000 dans chaque mode.

## 0.18.0 — 2026-11-23

Les moyens et les réseaux, en listes fermées et typées :
- constantes `PAYMENT_METHODS` et `NETWORKS` (types `PaymentMethod`, `Network`) : `mixx` (Mixx by Yas), `moov` (Moov Money / Flooz), `mtn_momo`, `orange_money`, `wave`… ;
- `pay.getPaymentMethods(country?)` (moyens et réseaux ouverts, `enabled`, votre ordre) et `pay.setPaymentMethods({ methods?, networks?, networkOrder? })` ;
- `askForPayment({ networks })` : les réseaux permis pour un paiement ;
- `Payment.network` (réseau avec lequel le client a payé), `Payment.networks`, `event.payment.network` ;
- ⚠️ `quote()` : `networks[i].network` vaut maintenant un réseau de `NETWORKS` (`"mixx"`, `"moov"`) au lieu d'un code technique (`"togocel"`, `"moov_tg"`). En entrée, `quote({ network: "togocel" })` reste accepté et vise `"mixx"`.

## 0.17.0 — 2026-11-23

Qui paie les frais, et combien paie le client :
- `pay.quote({ amount, country?, network?, currency?, fees?, method? })` (`POST /v1/quotes`), et son alias `pay.getFees` → `Quote` : `customerTotal` (ce que le client paie, à afficher), `processingFee` (frais du réseau de paiement), `commission`, `netAmount` (ce que vous recevez), `networks[]` (réseau par réseau, avec `operatorFeeEstimate`, une estimation des frais propres de l'opérateur, jamais promise). Rien n'est créé ;
- `fees: "customer"` couvre désormais TOUS les frais (réseau de paiement + commission) : vous recevez exactement `amount`. `fees: "partner"` : le client paie `amount`, frais compris ;
- `Payment` et l'avis `event.payment` : `customerTotal` et `processingFee` (`null` sur un serveur ancien) ;
- `amount_too_low` : `error.details.minimumAmount`.

## 0.16.0 — 2026-11-23

Frais au client : vous recevez exactement votre prix.
- `askForPayment({ …, fees: "customer" })` : la commission Technas s'ajoute à ce que paie le client au lieu d'être retenue sur `amount` (200 F à 2 % : le client paie 205, vous recevez 200). Sans `fees` : le réglage de votre compte (demandez-le à Technas). Mobile money en franc CFA seulement (`fees_customer_unavailable` sinon) ;
- `Payment` et l'avis `event.payment` : `customerAmount` (ce que le client paie, avant les frais du réseau mobile money) et `feesPaidBy`. `amount` reste VOTRE prix : comparez-le à votre facture comme avant.

## 0.15.1 — 2026-11-23

Un essai échoué ne bloque plus :
- `cancelPayment` peut répondre `payment_failed_page_open` (409, avec `expires_at`) : l'essai a échoué, rien n'est en cours chez l'opérateur, mais sa page reste ouverte jusqu'à son échéance (le fournisseur ne la ferme pas). Ne réessayez pas l'annulation : créez le nouvel essai. Avant, le serveur répondait `payment_in_progress`, qui interdit le nouvel essai, pendant une heure ;
- routes toutes faites : sur ce code, l'essai suivant est créé (deux pages payées = remboursement de l'essai en trop). Contrat v1 : 32 cas.

## 0.15.0 — 2026-11-19

Suivre ses reversements :
- avis `settlement.completed` et `settlement.failed` → `onSettlement(event)`, contenu typé `event.settlement` (`SettlementInfo`) : `amount` (ce qui a quitté le solde), `fee` (frais du versement mobile money), `netAmount` (ce qui arrive sur le numéro), `currency`, `status`, `createdAt`. Sur `settlement.failed`, `amount` est revenu sur le solde ;
- une version plus ancienne recevait déjà ces avis sous leur forme générique (`event.data`) : rien ne casse.

## 0.14.0 — 2026-11-16

Annuler un paiement :
- `pay.cancelPayment(id)` (`POST /v1/payments/{id}/cancel`) : annule DÉFINITIVEMENT un paiement que personne n'a commencé à payer (le client change d'offre). Rendu `expired`, `checkoutUrl` null ; rejouer rend le même résultat. Refus (409) : `payment_already_completed` (payé : relisez, ne créez rien, jamais à réessayer) et `payment_in_progress` (demande en cours chez l'opérateur : aucun second paiement, réessayable). L'identifiant est vérifié avant tout appel, comme pour `getPayment` ;
- `Payment` : `canceledAt`, `cancelReason` (`canceled_by_partner`) et `reason` ; avis `payment.expired` : `event.payment.reason` (`canceled` ou `timeout`, `null` dans un avis ancien) et `canceledAt`. Tous facultatifs ;
- routes toutes faites : `POST /payments/{id}/cancel` (mêmes contrôles que `GET /payments/{id}`), et sur `reference_conflict` l'ancien essai est relu par sa référence puis annulé s'il est encore ouvert avant le suivant ; payé ou demande en cours : erreur rendue à l'app, aucun second paiement ; une annulation qui répond 404 (serveur qui ne l'a pas encore) laisse passer à l'essai suivant, comme avant. Contrat v1 : 31 cas ;
- documentation : autre offre → annuler l'ancien essai, puis nouvel essai avec une nouvelle référence.

## 0.13.0 — 2026-11-15

Le client change d'offre ou revient plus tard :
- routes toutes faites : un essai d'un autre montant (`reference_conflict`, 409) est sauté comme un essai expiré : l'essai suivant est créé (même borne `maxAttempts`), jamais un refus. Contrat v1 : 24 cas ;
- documentation (README, AGENTS.md, llms.txt) : une référence = un essai, payée seulement sur `payment.completed`, un essai non payé ne bloque jamais un nouvel essai, `getPayment` au retour du client, `refund` si deux pages ont été payées.

## 0.12.1 — 2026-11-15

- Avis `account.kyc_required` : `event.kyc` porte aussi `stage`, `blockReason`, `daysElapsed`, `graceDays` et `firstCollectedAt`, comme `getAccountKyc()`. Facultatifs : `null` sur un avis plus ancien. `reason` ne change pas de sens.

## 0.12.0 — 2026-11-15

Seuil d'identité du compte :
- `pay.getAccountKyc()` (`GET /v1/account/kyc`) → `AccountKyc` : `stage`, `level`, `collectedXof`, `thresholdXof`, `graceDays`, `deadline`, `waiverUntil`, `reason`, `consoleUrl`… Valeurs inconnues de `stage`, `level`, `reason` gardées telles quelles ;
- avis `account.kyc_required` → `onKycRequired(event)`, contenu typé `event.kyc` (`KycRequiredEvent`) ;
- erreurs `kyc_required` et `contract_required` (409, pas à réessayer) : `error.details.consoleUrl`, `error.details.version` en plus de `reason`.

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
