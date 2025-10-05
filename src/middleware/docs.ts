import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";

// Este router expone la documentacion en Swagger UI y Redoc.
export function docsRouter(): Router {
  const r = Router();
  const specPath = path.join(process.cwd(), "openapi.yaml");
  const swaggerDoc = fs.existsSync(specPath)
    ? YAML.parse(fs.readFileSync(specPath, "utf8"))
    : { openapi: "3.0.0", info: { title: "CICD Safe Changes API", version: "v4" } };

  // Ofrecemos Swagger UI con explorador interactivo.
  r.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc, { explorer: true }));

  // Endpoint JSON para clientes que necesiten el spec directo.
  r.get("/docs.json", (_req, res) => res.json(swaggerDoc));

  // Vista alternativa en Redoc para una documentacion mas legible.
  r.get("/redoc", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>API Docs</title>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script></head>
    <body><redoc spec-url="/docs.json"></redoc></body></html>`);
  });
  return r;
}
