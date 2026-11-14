// Résolu à la place du package quand il est importé dans du code navigateur.
// Le secret ne doit jamais y arriver : on casse tout de suite et clairement.
throw new Error(
  "@technas/pay s'utilise côté serveur uniquement (Node, Bun, Deno, fonctions serverless). " +
    "Ne l'importez pas dans du code navigateur ni dans une app mobile : votre secret y serait exposé.",
);
export {};
