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

const PORT = parseInt(process.env.PORT || "8080", 10);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

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

if ((process.env.AUTO_DOCS || "0") === "1") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oas = require("express-oas-generator");
  oas.init(app, {});
}

// basic access log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, version: "v4" }));
app.use("/changes", changesRouter);
app.use("/", docsRouter());

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error");
  res.status(err?.status || 500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => logger.info({ PORT }, "API v4 listening"));
