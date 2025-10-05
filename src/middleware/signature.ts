import { createHmac } from "crypto";
import { Request, Response, NextFunction } from "express";

export function verifySignature() {
  const secret = process.env.HMAC_SECRET || "";
  return (req: Request, res: Response, next: NextFunction) => {
    if (!secret) return next();
    const sig = (req.headers["x-signature"] as string) || "";
    if (!sig) return res.status(401).json({ error: "Missing X-Signature" });
    const raw = JSON.stringify(req.body || {});
    const calc = createHmac("sha256", secret).update(raw).digest("hex");
    if (calc !== sig) return res.status(401).json({ error: "Invalid signature" });
    next();
  };
}
