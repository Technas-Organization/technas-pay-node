// Routes toutes faites pour une app (technas_pay_flutter, TechnasPayClient) : contrat
// `contract/app-contract.v1.json`, rejoué par les tests de ce dépôt ET par ceux du client Flutter.
//
// Le partenaire ne fournit que deux crochets :
//   - `authorize(request)` : SON authentification ; rend l'utilisateur, ou null (401) ;
//   - `resolveOrder(orderId, user)` : relit la commande EN BASE (montant, client) ; null si elle
//     n'existe pas ou n'est pas à cet utilisateur (404). Le montant ne vient jamais du téléphone.
// La clé API ne quitte jamais le serveur ; l'app ne reçoit que `toAppJson(payment)`.

import {
  readRawBody,
  retryReference,
  TechnasPayError,
  toAppJson,
  type CardAccount,
  type NodeLikeRequest,
  type NodeLikeResponse,
  type Payment,
  type TechnasPayEvent,
  type WebhookHandlers,
} from "./index.js";

/** Ce que `resolveOrder` rend : relu en base, jamais pris de la requête de l'app. */
export interface AppOrder {
  /** Entier en unité principale (5000 = 5 000 FCFA). */
  amount: number;
  customer: { email: string; name: string; phone?: string; country?: string };
  /** Facultatif : sans elle, la devise suit le pays du client (zone franc CFA). */
  currency?: string;
  description?: string;
  /** Page de retour (lien qui rouvre l'app) ; sinon `returnUrl` des options. */
  returnUrl?: string;
  metadata?: Record<string, unknown>;
}

/** La requête, vue indépendamment du framework. `path` est relatif au préfixe de montage. */
export interface AppRequest {
  method: string;
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  /** Corps brut (le webhook en a besoin pour la signature). */
  rawBody: string;
  /** L'objet de requête du framework, passé tel quel à `authorize`. */
  original?: unknown;
}

export interface AppResponse {
  status: number;
  body: unknown;
}

export interface AppRoutesOptions<User> {
  /** Votre authentification. Rendez l'utilisateur, ou null/undefined (réponse 401). */
  authorize: (request: AppRequest) => User | null | undefined | Promise<User | null | undefined>;
  /** La commande de CET utilisateur, relue en base ; null/undefined si inconnue ou à un autre (404). */
  resolveOrder: (orderId: string, user: User) => AppOrder | null | undefined | Promise<AppOrder | null | undefined>;
  /** Page de retour par défaut (https, ou lien qui rouvre l'app). */
  returnUrl?: string;
  /** Vos fonctions de webhook (`onCompleted` marque la commande payée…). Route : POST /webhook. */
  webhooks?: WebhookHandlers;
  /** Nombre maximal d'essais expirés sautés pour une commande (20 par défaut). */
  maxAttempts?: number;
  /**
   * Proposer la carte. Elle n'est ouverte que si votre compte carte est prêt
   * (`getCardAccount().canAcceptPayments`) et que la commande a une `currency`.
   */
  card?: boolean;
  /**
   * Le MARCHAND (votre administrateur), pour `GET /card/account` et `POST /card/onboarding`.
   * Rendez-le, ou null (403). Sans ce crochet, ces routes n'existent pas.
   */
  authorizeAdmin?: (request: AppRequest) => unknown | Promise<unknown>;
}

/** La partie du client utilisée ici (le client complet convient). */
interface PayLike {
  askForPayment(input: any): Promise<Payment>;
  getCardAccount(): Promise<CardAccount>;
  startCardOnboarding(input: any): Promise<{ url: string; kind: string; expiresAt: string | null; account: CardAccount }>;
  getPayment(id: string): Promise<Payment>;
  handleWebhook(raw: string | Uint8Array, signature: string | null | undefined, handlers: WebhookHandlers): Promise<{ status: number; body: unknown; event?: TechnasPayEvent }>;
}

const err = (status: number, code: string, message: string, retryable = false): AppResponse => ({
  status,
  body: { code, message, retryable },
});

function fromPayError(e: TechnasPayError): AppResponse {
  // Panne ou réseau côté Technas : 502, à relire plus tard. Sinon le refus est transmis tel quel.
  if (e.code === "network_error" || e.status >= 500 || e.status === 0) {
    return err(502, e.code, e.message, true);
  }
  return err(e.status, e.code, e.message, e.retryable);
}

function queryOf(url: URL): Record<string, string> {
  const q: Record<string, string> = {};
  url.searchParams.forEach((v, k) => (q[k] = v));
  return q;
}

/** `42-3` ou `42-card-3` → `42` (la commande d'un essai). */
function orderIdOf(reference: string): string {
  const m = /^(.+?)-(?:card-)?\d+$/.exec(reference);
  return m ? m[1]! : reference;
}

/** Ce que l'app voit du compte carte : ni pays, ni identifiants. */
function appAccount(a: CardAccount) {
  return {
    status: a.status,
    can_accept_payments: a.canAcceptPayments,
    payouts_enabled: a.payoutsEnabled,
    requirements: a.requirements,
    disabled_reason: a.disabledReason,
  };
}

export function createAppRoutes<User>(pay: PayLike, options: AppRoutesOptions<User>) {
  const maxAttempts = options.maxAttempts ?? 20;

  async function startPayment(orderId: string, order: AppOrder, method: "mobile_money" | "card"): Promise<Payment> {
    // Une référence = un essai : `orderId-1`, puis `-2`… Un essai expiré lève payment_expired,
    // on passe au suivant. Un essai en cours (ou payé) est rendu tel quel : jamais deux paiements.
    for (let attempt = 1; ; attempt++) {
      try {
        return await pay.askForPayment({
          amount: order.amount,
          // La carte a ses propres essais : un essai mobile money en cours n'est jamais heurté.
          reference: method === "card" ? `${orderId}-card-${attempt}` : retryReference(orderId, attempt),
          ...(method === "card" ? { method } : {}),
          customer: order.customer,
          returnUrl: order.returnUrl ?? options.returnUrl,
          ...(order.currency ? { currency: order.currency } : {}),
          ...(order.description ? { description: order.description } : {}),
          metadata: { ...(order.metadata ?? {}), order_id: orderId },
        });
      } catch (e) {
        if (e instanceof TechnasPayError && e.code === "payment_expired" && attempt < maxAttempts) continue;
        throw e;
      }
    }
  }

  /** La carte pour cette commande : ouverte seulement si le marchand l'a voulue et que son compte est prêt. */
  async function cardMethod(order: AppOrder) {
    if (!options.card) return { method: "card", available: false, reason: "not_enabled" };
    if (!order.currency) return { method: "card", available: false, reason: "currency_required" };
    const account = await pay.getCardAccount();
    return account.canAcceptPayments
      ? { method: "card", available: true, reason: null }
      : { method: "card", available: false, reason: "card_account_not_ready" };
  }

  async function handle(req: AppRequest): Promise<AppResponse> {
    const path = "/" + req.path.replace(/^\/+|\/+$/g, "");
    const method = req.method.toUpperCase();

    if (method === "POST" && path === "/webhook") {
      if (!options.webhooks) return err(404, "not_found", "Webhook non branché");
      const r = await pay.handleWebhook(req.rawBody, req.headers["x-technas-payment-signature"], options.webhooks);
      return { status: r.status, body: r.body };
    }

    // Routes du marchand : compte carte. Elles n'existent que si `authorizeAdmin` est branché.
    if ((method === "GET" && path === "/card/account") || (method === "POST" && path === "/card/onboarding")) {
      if (!options.authorizeAdmin) return err(404, "not_found", "Route inconnue");
      const admin = await options.authorizeAdmin(req);
      if (admin === null || admin === undefined || admin === false) return err(403, "forbidden", "Réservé au marchand");
      try {
        if (path === "/card/account") return { status: 200, body: { account: appAccount(await pay.getCardAccount()) } };
        let body: any;
        try {
          body = req.rawBody ? JSON.parse(req.rawBody) : {};
        } catch {
          return err(400, "invalid_request", "Corps JSON illisible");
        }
        if (typeof body?.returnUrl !== "string" || typeof body?.refreshUrl !== "string") {
          return err(400, "invalid_request", "returnUrl et refreshUrl sont obligatoires");
        }
        const link = await pay.startCardOnboarding({
          country: body.country,
          email: body.email,
          businessType: body.businessType,
          returnUrl: body.returnUrl,
          refreshUrl: body.refreshUrl,
        });
        return { status: 200, body: { url: link.url, kind: link.kind, expires_at: link.expiresAt, account: appAccount(link.account) } };
      } catch (e) {
        if (e instanceof TechnasPayError) return fromPayError(e);
        throw e;
      }
    }

    const known = (method === "GET" && (path === "/methods" || /^\/payments\/[^/]+$/.test(path))) || (method === "POST" && path === "/payments");
    if (!known) return err(404, "not_found", "Route inconnue");

    const user = await options.authorize(req);
    if (user === null || user === undefined) return err(401, "unauthorized", "Connexion requise");

    try {
      if (path === "/methods") {
        const orderId = req.query.orderId;
        if (!orderId) return err(400, "invalid_request", "orderId manquant");
        const order = await options.resolveOrder(orderId, user);
        if (!order) return err(404, "order_not_found", "Commande introuvable");
        return {
          status: 200,
          body: {
            amount: order.amount,
            currency: order.currency ?? null,
            // La carte s'ouvre avec le compte carte du marchand (Stripe Connect) : à venir.
            methods: [{ method: "mobile_money", available: true, reason: null }, await cardMethod(order)],
          },
        };
      }

      if (path === "/payments") {
        let body: any;
        try {
          body = req.rawBody ? JSON.parse(req.rawBody) : {};
        } catch {
          return err(400, "invalid_request", "Corps JSON illisible");
        }
        const orderId = typeof body?.orderId === "string" || typeof body?.orderId === "number" ? String(body.orderId) : "";
        if (!orderId) return err(400, "invalid_request", "orderId manquant");
        const method = body?.method ?? "mobile_money";
        if (method !== "mobile_money" && method !== "card") return err(400, "invalid_request", 'method vaut "mobile_money" ou "card"');
        if (method === "card" && !options.card) return err(400, "method_not_available", "Le paiement par carte n'est pas ouvert");
        const order = await options.resolveOrder(orderId, user);
        if (!order) return err(404, "order_not_found", "Commande introuvable");
        if (method === "card" && !order.currency) return err(400, "currency_required", "La commande n'a pas de devise : carte impossible");
        return { status: 200, body: { payment: toAppJson(await startPayment(orderId, order, method)) } };
      }

      // GET /payments/{id} : seulement si la commande de ce paiement est à cet utilisateur.
      const id = decodeURIComponent(path.slice("/payments/".length));
      let payment: Payment;
      try {
        payment = await pay.getPayment(id);
      } catch (e) {
        if (e instanceof TechnasPayError && e.code === "payment_not_found") return err(404, "payment_not_found", "Paiement introuvable");
        throw e;
      }
      const order = await options.resolveOrder(orderIdOf(payment.reference), user);
      if (!order) return err(404, "payment_not_found", "Paiement introuvable");
      return { status: 200, body: { payment: toAppJson(payment) } };
    } catch (e) {
      if (e instanceof TechnasPayError) return fromPayError(e);
      throw e;
    }
  }

  return {
    /** Le cœur, sans framework : rend `{ status, body }`. */
    handle,

    /**
     * Norme fetch (`Request` → `Response`) : Next.js App Router, Hono, Remix, Bun, Deno.
     * [basePath] : le préfixe où les routes sont montées (`/api/technas-pay`).
     * Next : `app/api/technas-pay/[...path]/route.ts` →
     * `export const { GET, POST } = pay.appRoutes({...}).nextHandlers("/api/technas-pay")`.
     */
    fetchHandler(basePath: string) {
      const prefix = "/" + basePath.replace(/^\/+|\/+$/g, "");
      return async (request: Request): Promise<Response> => {
        const url = new URL(request.url);
        const path = url.pathname.startsWith(prefix) ? url.pathname.slice(prefix.length) : url.pathname;
        const headers: Record<string, string> = {};
        request.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        const r = await handle({
          method: request.method,
          path,
          query: queryOf(url),
          headers,
          rawBody: request.method === "GET" ? "" : await request.text(),
          original: request,
        });
        return Response.json(r.body, { status: r.status });
      };
    },

    /** Les exports d'un Route Handler Next.js `[...path]/route.ts`. */
    nextHandlers(basePath = "/api/technas-pay") {
      const h = this.fetchHandler(basePath);
      return { GET: h, POST: h };
    },

    /**
     * Style Node (`req, res, next`) : Express, Connect, NestJS, `node:http`.
     * `app.use("/api/technas-pay", pay.appRoutes({...}).node)`, AVANT `express.json()` (le
     * webhook a besoin du corps brut).
     */
    node: async (req: NodeLikeRequest & { method?: string; url?: string; originalUrl?: string }, res: NodeLikeResponse, next?: (e?: unknown) => void) => {
      try {
        const url = new URL(req.url ?? "/", "http://local");
        const headers: Record<string, string | undefined> = {};
        for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
        let rawBody = "";
        if ((req.method ?? "GET").toUpperCase() !== "GET") {
          const parsed = req.body;
          if (parsed && typeof parsed === "object" && !(parsed instanceof Uint8Array) && !url.pathname.endsWith("/webhook")) {
            rawBody = JSON.stringify(parsed); // express.json() est passé : suffisant hors webhook
          } else {
            const raw = await readRawBody(req);
            rawBody = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
          }
        }
        const r = await handle({
          method: req.method ?? "GET",
          path: url.pathname,
          query: queryOf(url),
          headers,
          rawBody,
          original: req,
        });
        res.statusCode = r.status;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(r.body));
      } catch (e) {
        if (next) return next(e);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ code: "internal_error", message: "Erreur interne", retryable: true }));
      }
    },
  };
}

export type AppRoutes = ReturnType<typeof createAppRoutes>;
