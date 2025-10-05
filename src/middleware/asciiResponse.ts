export function toAscii(s: string): string {
  try {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
  } catch { return s; }
}
function sanitize(obj: any): any {
  if (obj == null) return obj;
  if (typeof obj === "string") return toAscii(obj);
  if (Array.isArray(obj)) return obj.map(sanitize);
  if (typeof obj === "object") {
    const out: any = { ...obj };
    for (const k of Object.keys(out)) {
      if (k === "message" || k === "error") out[k] = sanitize(out[k]);
    }
    return out;
  }
  return obj;
}
export function asciiResponse() {
  return (_req: any, res: any, next: any) => {
    const _json = res.json.bind(res);
    res.json = (body: any) => _json(sanitize(body));
    next();
  };
}
