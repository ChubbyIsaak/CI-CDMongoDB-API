import crypto from "crypto";

export function newChangeId(): string {
  const d = new Date();
  const y = d.getUTCFullYear().toString();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const rnd = crypto.randomBytes(4).toString("hex");
  return `chg-${y}${m}${day}-${rnd}`;
}
