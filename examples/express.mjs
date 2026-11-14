// Technas Pay avec Express.
//   npm install express github:Technas-Organization/technas-pay-node#v0.9.0
//   TECHNAS_PAY_SECRET=tps_test_... node examples/express.mjs
import express from "express";
import { createTechnasPay, retryReference } from "@technas/pay";

// Côté serveur uniquement. Le secret est lu au premier appel.
export const pay = createTechnasPay({ secret: process.env.TECHNAS_PAY_SECRET });

// Remplacez par votre base de données.
export const orders = new Map([["42", { amount: 5000, attempt: 1, paid: false, paymentId: null }]]);

export const app = express();

// 1. Le webhook, monté AVANT express.json() : la signature porte sur le corps brut.
app.post(
  "/api/technas-pay",
  express.raw({ type: "application/json" }),
  pay.nodeHandler({
    async onCompleted(event) {
      const orderId = event.payment.reference.split("-").slice(0, -1).join("-");
      orders.get(orderId).paid = true; // idempotent : un webhook peut arriver deux fois
    },
    async onExpired(event) {
      // Seul moment où relancer : NOUVELLE référence (tentative + 1).
      const orderId = event.payment.reference.split("-").slice(0, -1).join("-");
      orders.get(orderId).attempt += 1;
    },
  }),
);

app.use(express.json());

// 2. Demander un paiement : le montant vient de VOTRE base, jamais du navigateur.
app.post("/orders/:id/pay", async (req, res, next) => {
  try {
    const order = orders.get(req.params.id);
    const payment = await pay.askForPayment({
      amount: order.amount,
      reference: retryReference(req.params.id, order.attempt),
      customer: { email: "awa@exemple.tg", name: "Awa Mensah" },
      returnUrl: "https://votre-site.example/merci",
    });
    order.paymentId = payment.id;
    res.redirect(303, payment.checkoutUrl);
  } catch (error) {
    next(error);
  }
});

if (import.meta.url === `file://${process.argv[1]}`) app.listen(3000);
