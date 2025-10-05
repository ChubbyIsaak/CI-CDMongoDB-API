import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

// Este factory arma el middleware para validar JWT segun configuracion.
export function authRequired() {
  const required = (process.env.JWT_REQUIRED || "true").toLowerCase() === "true";
  const secret = process.env.JWT_SECRET || "";
  return (req: Request, res: Response, next: NextFunction) => {
    if (!required) return next();
    if (!secret) return res.status(500).json({ error: "JWT validation is enabled but JWT_SECRET is not configured." });
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing bearer token in Authorization header." });
    try {
      const payload = jwt.verify(token, secret);
      (req as any).user = payload;
      return next();
    } catch {
      return res.status(401).json({ error: "Token verification failed." });
    }
  };
}
