// Esta utilidad quita acentos y caracteres raros para mantener respuestas ASCII.
export function toAscii(s: string): string {
  try {
    return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7E]/g, "?");
  } catch { return s; }
}

// Este helper recorre objetos y limpia los campos de texto que enviamos al cliente.
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

// Middleware que intercepta res.json para entregar textos limpios en ASCII.
export function asciiResponse() {
  return (_req: any, res: any, next: any) => {
    const _json = res.json.bind(res);
    res.json = (body: any) => _json(sanitize(body));
    next();
  };
}
