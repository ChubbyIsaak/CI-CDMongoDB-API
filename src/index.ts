import "dotenv/config";
import express from "express";
import pino from "pino";
import helmet from "helmet";
import cors from "cors";
import { router as changesRouter } from "./routes/changes.routes";
import { authRequired } from "./middleware/authRequired";
import { limiter } from "./middleware/rateLimit";
import { ipAllowlist } from "./middleware/ipAllowlist";
import { asciiResponse } from "./middleware/asciiResponse";
import { docsRouter } from "./middleware/docs";

// Definimos puerto y logger para saber como corre la app.
const PORT = parseInt(process.env.PORT || "8080", 10);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

// Creamos la app y configuramos middlewares comunes de seguridad y parsing.
const app = express();
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean),
}));
app.use(express.json({ limit: "256kb" }));
app.use(asciiResponse());
app.use(ipAllowlist());
app.use(authRequired());
app.use(limiter());

// Si se activa, generamos documentacion automatica de OpenAPI.
if ((process.env.AUTO_DOCS || "0") === "1") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oas = require("express-oas-generator");
  oas.init(app, {});
}

// Registramos un acceso simple para saber quien llama.
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});

// Ruta de salud para confirmar que la API responde.
app.get("/health", (_req, res) => res.json({ status: "healthy", version: "v4" }));
// Rutas principales para gestionar cambios.
app.use("/changes", changesRouter);
// Rutas que sirven la documentacion publica.
app.use("/", docsRouter());

// Manejador final de errores para responder en ingles y loguear.
app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error");
  res.status(err?.status || 500).json({ error: "Internal Server Error" });
});

// Arrancamos el servidor HTTP.
app.listen(PORT, () => logger.info({ PORT }, "API v4 listening"));
