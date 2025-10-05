import { Request, Response, NextFunction } from "express";
import ipaddr from "ipaddr.js";

// Este helper convierte direcciones en formato uniforme, incluso si vienen ipv6 mapeadas.
function normalizeIp(ip: string): string {
  try {
    const addr = ipaddr.parse(ip);
    if (addr.kind() === "ipv6" && typeof (addr as any).isIPv4MappedAddress === "function" && (addr as any).isIPv4MappedAddress()) {
      const v4 = (addr as any).toIPv4Address?.();
      return v4 ? v4.toString() : addr.toString();
    }
    return addr.toString();
  } catch {
    return ip;
  }
}

// Este middleware solo deja pasar IPs incluidas en la lista configurada.
export function ipAllowlist() {
  const raw = (process.env.IP_ALLOWLIST || "").trim();
  if (!raw) return (_req: Request, _res: Response, next: NextFunction) => next();

  const list = raw.split(",").map(s => s.trim()).filter(Boolean);

  return (req: Request, res: Response, next: NextFunction) => {
    const fwd = (req.headers["x-forwarded-for"] as string) || "";
    const clientIp = normalizeIp(fwd.split(",")[0].trim() || (req.socket.remoteAddress || ""));

    let allowed = false;
    try {
      const addr = ipaddr.parse(clientIp);

      allowed = list.some(entry => {
        if (entry.includes("/")) {
          try {
            const [net, prefix] = ipaddr.parseCIDR(entry);
            return (addr as any).match([net, prefix]);
          } catch { return false; }
        }
        try { return addr.toString() === ipaddr.parse(entry).toString(); }
        catch { return false; }
      });
    } catch { allowed = false; }

    if (!allowed) return res.status(403).json({ error: "Access denied because the IP address is not allowlisted." });
    next();
  };
}
