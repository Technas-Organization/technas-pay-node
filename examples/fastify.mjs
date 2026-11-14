// Technas Pay avec Fastify.
//   npm install fastify github:Technas-Organization/technas-pay-node#v0.9.0
import Fastify from "fastify";
import { createTechnasPay } from "@technas/pay";

export const pay = createTechnasPay({ secret: process.env.TECHNAS_PAY_SECRET });
export const paid = new Set();

export function build() {
  const app = Fastify();
  // Garder le corps BRUT pour la route webhook : la signature porte dessus.
  app.register(async (scope) => {
    scope.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => done(null, body));
    scope.post("/api/technas-pay", async (request, reply) => {
      const result = await pay.handleWebhook(request.body, request.headers["x-technas-payment-signature"], {
        async onCompleted(event) {
          paid.add(event.payment.reference);
        },
      });
      // Une erreur de vos fonctions remonte : Fastify répond 500 et Technas relivre.
      return reply.code(result.status).send(result.body);
    });
  });
  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) build().listen({ port: 3000 });
