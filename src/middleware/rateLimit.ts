import rateLimit from "express-rate-limit";

// Este middleware controla el ritmo de solicitudes para evitar abusos.
export function limiter() {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
  const max = parseInt(process.env.RATE_LIMIT_MAX || "120", 10);
  return rateLimit({ windowMs, max, legacyHeaders: false, standardHeaders: true });
}
