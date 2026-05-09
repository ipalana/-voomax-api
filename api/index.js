// api/index.js  ← Vercel procura funções serverless na pasta /api
// Este arquivo é o entry point que a Vercel executa

import app from "../src/index.js";

export default app.fetch;
