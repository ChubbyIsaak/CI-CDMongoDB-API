import { Request, Response } from "express";
import { ChangeRequestSchema } from "../lib/validator";
import { applyChange, applyBatch, revertChange, listChanges, getChange } from "../services/changes.service";
import { newChangeId } from "../lib/ids";
import { opsLog } from "../lib/ops-logger";

// Esta funcion convierte distintos valores a un booleano de forma simple.
function coerceBoolean(value: unknown, fallback = false): boolean {
  if (value === undefined || value === null) return fallback;
  if (Array.isArray(value)) {
    return value.length ? coerceBoolean(value[value.length - 1], fallback) : fallback;
  }
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "") return fallback;
    if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "off"].includes(normalized)) return false;
    return fallback;
  }
  if (typeof value === "object") {
    const primitive = (value as { valueOf?: () => unknown }).valueOf?.();
    if (primitive !== undefined && primitive !== value) {
      return coerceBoolean(primitive, fallback);
    }
  }
  return fallback;
}

// Controlador que aplica un cambio individual recibido por POST.
export async function applyChangeController(req: Request, res: Response) {
  // Nos aseguramos de tener un cuerpo para trabajar.
  const body = (req.body ?? {}) as any;
  if (!req.body) req.body = body;

  if (!body.changeId) body.changeId = newChangeId();
  const dryRun = coerceBoolean(req.query.dryRun, coerceBoolean(body.dryRun, false));
  const parsed = ChangeRequestSchema.safeParse(body);
  if (!parsed.success) {
    return res.status(400).json({
      error: "Validation failed",
      details: parsed.error.flatten()
    });
  }

  // Registramos quien lanzo la operacion y con que datos.
  const actor = (req as any).user || {};
  opsLog({
    at: new Date().toISOString(),
    kind: "apply",
    actor: { sub: actor.sub, email: actor.email },
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"],
    changeId: parsed.data.changeId,
    targetDb: parsed.data.target.database,
    opType: parsed.data.operation.type,
    collection: (parsed.data as any).operation.collection,
    dryRun
  });

  // Aplicamos el cambio y guardamos el resultado.
  const result = await applyChange(parsed.data, { dryRun });

  // Guardamos el resultado en el log para tener trazabilidad.
  opsLog({
    at: new Date().toISOString(),
    kind: "apply.result",
    changeId: parsed.data.changeId,
    status: (result as any).status,
    message: (result as any).message,
    durationMs: (result as any).durationMs
  });

  return res.json({ ...result, changeId: parsed.data.changeId });
}

// Controlador que procesa un lote de cambios enviados por POST.
export async function applyBatchController(req: Request, res: Response) {
  // Reunimos los datos principales del cuerpo.
  const body = (req.body ?? {}) as any;
  if (!req.body) req.body = body;

  const changes = body.changes as any[];
  const stopOnError = coerceBoolean(body.stopOnError, true);
  const dryRun = coerceBoolean(body.dryRun, false);

  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: "The request must include a non-empty changes array." });
  }
  const parsed = changes.map((c: any) => {
    if (!c.changeId) c.changeId = newChangeId();
    const p = ChangeRequestSchema.safeParse(c);
    if (!p.success) return { error: p.error.flatten() };
    return p.data;
  });
  const invalid = parsed.find((x: any) => (x as any).error);
  if (invalid) {
    return res.status(400).json({
      error: "One or more changes are invalid.",
      details: (invalid as any).error
    });
  }

  // Log de quien pidio la operacion en lote para control operacional.
  const actor = (req as any).user || {};
  opsLog({
    at: new Date().toISOString(),
    kind: "applyBatch",
    actor: { sub: actor.sub, email: actor.email },
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"],
    count: parsed.length,
    dryRun
  });

  // Ejecutamos el lote y devolvemos como salio.
  const result = await applyBatch(parsed as any[], { stopOnError, dryRun });

  // Guardamos info extra del resultado por si algo falla.
  opsLog({
    at: new Date().toISOString(),
    kind: "applyBatch.result",
    status: (result as any).status,
    failedAt: (result as any).failedAt
  });

  return res.json(result);
}

// Controlador que revierte un cambio via POST.
export async function revertChangeController(req: Request, res: Response) {
  // Sacamos los datos minimos para revertir.
  const { changeId, uri, database } = req.body || {};
  if (!changeId || !uri) {
    return res.status(400).json({ error: "Both changeId and uri are required." });
  }

  // Registramos quien solicita revertir para auditoria.
  const actor = (req as any).user || {};
  opsLog({
    at: new Date().toISOString(),
    kind: "revert",
    actor: { sub: actor.sub, email: actor.email },
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"],
    changeId,
    database
  });

  // Lanzamos la operacion y esperamos la respuesta.
  const result = await revertChange(changeId, { uri, database });

  // Guardamos el resultado con el mismo id para seguimiento.
  opsLog({
    at: new Date().toISOString(),
    kind: "revert.result",
    changeId,
    status: (result as any).status,
    message: (result as any).message
  });

  return res.json(result);
}

// Controlador que trae un cambio por GET usando su id.
export async function getChangeController(req: Request, res: Response) {
  // Tomamos el changeId y la conexion de la consulta.
  const { changeId } = req.params;
  const uri = (req.query.uri as string) || (req.body?.target?.uri as string);
  if (!uri) {
    return res.status(400).json({ error: "Query parameter uri is required." });
  }
  const result = await getChange(changeId, { uri });
  if (!result) {
    return res.status(404).json({ error: "Requested change was not found." });
  }
  return res.json(result);
}

// Controlador que lista cambios pendientes usando GET.
export async function listPendingController(req: Request, res: Response) {
  // Leemos los filtros que llegan en la consulta.
  const uri = req.query.uri as string;
  if (!uri) {
    return res.status(400).json({ error: "Query parameter uri is required." });
  }
  const onlyApplied = (req.query.onlyApplied as string) === "true";
  const status = (req.query.status as string) || (onlyApplied ? "applied" : undefined);
  const since = req.query.since as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);
  const skip = parseInt((req.query.skip as string) || "0", 10);

  // Pedimos la lista al servicio y la devolvemos como llega.
  const result = await listChanges(uri, { status, since, limit, skip });
  return res.json(result);
}
