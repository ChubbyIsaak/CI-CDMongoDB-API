import { MongoClient, Db } from "mongodb";
import { ChangeRequestSchema } from "../lib/validator";
import { newChangeId } from "../lib/ids";
import { getClient } from "./mongo.service";
import type { ChangeRequest } from "../types/change";

// Esta constante mantiene el nombre de la coleccion de auditoria.
const AUDIT_COLLECTION = "cicd_changes_audit";

// Definimos opciones para aplicar cambios individuales o en lote.
type ApplyOptions = { dryRun?: boolean };
type BatchOptions = { stopOnError?: boolean; dryRun?: boolean };

// Este helper obtiene la base de datos donde guardamos los registros de auditoria.
function auditDb(client: MongoClient): Db {
  const dbName = process.env.AUDIT_DB || "admin";
  return client.db(dbName);
}

// Aplica un cambio individual y deja rastro en auditoria.
export async function applyChange(req: any, opts: ApplyOptions = {}) {
  const t0 = Date.now();
  const dryRun = !!opts.dryRun;
  const parsed = ChangeRequestSchema.parse(req);
  const changeId = parsed.changeId || newChangeId();

  const client = await getClient(parsed.target.uri);
  const db = client.db(parsed.target.database);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);

  let status: "applied" | "skipped" | "failed" = "applied";
  let message = "Change applied successfully.";
  let revertPlan: any = null;

  try {
    if (parsed.operation.type === "createCollection") {
      const name = parsed.operation.collection;
      const exists = (await db.listCollections({ name }).toArray()).length > 0;
      if (exists) {
        status = "skipped";
        message = "Change skipped because the collection already exists.";
        revertPlan = { type: "dropCollection", collection: name, requiresEmpty: true };
      } else {
        if (!dryRun) {
          await db.createCollection(name, parsed.operation.options || {});
        }
        revertPlan = { type: "dropCollection", collection: name, requiresEmpty: true };
      }
    } else if (parsed.operation.type === "createIndex") {
      const { collection, spec, options } = parsed.operation;
      const name = options?.name || "idx_" + Object.keys(spec).join("_");
      const coll = db.collection(collection);
      const indexes = await coll.indexes();
      const sameName = indexes.find(i => i.name === name);
      if (sameName) {
        const sameKeys = JSON.stringify(sameName.key) === JSON.stringify(spec);
        if (sameKeys) {
          status = "skipped";
          message = "Change skipped because an index with the same name and keys already exists.";
        } else {
          throw new Error("An index with this name already exists but uses different keys.");
        }
      } else {
        if (!dryRun) {
          await coll.createIndex(spec as any, { ...(options || {}), name });
        }
      }
      revertPlan = { type: "dropIndex", collection, name };
    } else {
      throw new Error("Unsupported operation type for applyChange.");
    }

    // Registramos la operacion en la auditoria si no es simulacion.
    if (!dryRun) {
      await audit.insertOne({
        changeId,
        target: parsed.target,
        operation: parsed.operation,
        metadata: parsed.metadata || {},
        status,
        message,
        revertPlan,
        createdAt: new Date(),
      });
    }

    return { changeId, status, message, revertPlan, durationMs: Date.now() - t0 };
  } catch (err: any) {
    const errorMessage = String(err?.message || err);
    if (!dryRun) {
      await audit.insertOne({
        changeId,
        target: parsed.target,
        operation: parsed.operation,
        metadata: parsed.metadata || {},
        status: "failed",
        message: errorMessage,
        createdAt: new Date(),
      });
    }
    return { changeId, status: "failed", message: errorMessage, durationMs: Date.now() - t0 };
  }
}

// Aplica una lista de cambios y puede cortar si algo falla.
export async function applyBatch(changes: any[], opts: BatchOptions = {}) {
  const stopOnError = opts.stopOnError !== false;
  const dryRun = !!opts.dryRun;
  const results: any[] = [];
  const applied: any[] = [];

  for (let i = 0; i < changes.length; i++) {
    const c = { ...changes[i] };
    if (!c.changeId) c.changeId = newChangeId();
    const res = await applyChange(c, { dryRun });
    results.push(res);
    if (res.status === "failed" && stopOnError && !dryRun) {
      // Intentamos revertir los cambios que ya se aplicaron.
      for (let j = applied.length - 1; j >= 0; j--) {
        const a = applied[j];
        try { await revertChange(a.changeId, { uri: a.target.uri, database: a.target.database }); } catch {}
      }
      return { status: "rolled_back", failedAt: i, results };
    }
    if (res.status === "applied" && !dryRun) {
      applied.push({ changeId: res.changeId, target: changes[i].target });
    }
  }

  return { status: "ok", results };
}

// Revierten un cambio aplicado previamente usando su changeId.
export async function revertChange(changeId: string, ctx: { uri: string; database?: string }) {
  const client = await getClient(ctx.uri);
  const db = ctx.database ? client.db(ctx.database) : undefined;
  const audit = auditDb(client).collection(AUDIT_COLLECTION);

  // Buscamos el ultimo registro para ese changeId y la misma URI.
  const rec = await audit.find({ changeId, "target.uri": ctx.uri }).sort({ createdAt: -1 }).limit(1).next();
  if (!rec) return { changeId, status: "failed", message: "No audit entry was found for the requested changeId." };

  const targetDb = db || client.db(rec.target.database);
  const changeRecord: ChangeRequest = {
    changeId: rec.changeId,
    target: rec.target,
    operation: rec.operation,
    metadata: rec.metadata || {},
  };

  if (rec.operation.type === "createIndex") {
    const { collection } = rec.operation;
    const name = rec.operation.options?.name || "idx_" + Object.keys(rec.operation.spec).join("_");
    try {
      await targetDb.collection(collection).dropIndex(name);
      await audit.updateOne({ _id: rec._id }, { $set: { revertedAt: new Date(), revertMessage: "Index dropped successfully.", status: "reverted" } });
      return { changeId, status: "reverted", message: "Index dropped successfully.", change: changeRecord };
    } catch (err: any) {
      return { changeId, status: "failed", message: "Failed to drop index: " + String(err?.message || err), change: changeRecord };
    }
  } else if (rec.operation.type === "createCollection") {
    const { collection } = rec.operation;
    const coll = targetDb.collection(collection);
    const count = await coll.countDocuments();
    if (count > 0) {
      return { changeId, status: "failed", message: "Cannot drop the collection because it is not empty.", change: changeRecord };
    }
    try {
      await targetDb.dropCollection(collection);
      await audit.updateOne({ _id: rec._id }, { $set: { revertedAt: new Date(), revertMessage: "Collection dropped successfully.", status: "reverted" } });
      return { changeId, status: "reverted", message: "Collection dropped successfully.", change: changeRecord };
    } catch (err: any) {
      return { changeId, status: "failed", message: "Failed to drop collection: " + String(err?.message || err), change: changeRecord };
    }
  } else {
    return { changeId, status: "failed", message: "Unsupported operation type for revertChange.", change: changeRecord };
  }
}

// Lista los cambios desde la auditoria aplicando filtros simples.
export async function listChanges(uri: string, q: { status?: string; since?: string; limit?: number; skip?: number }) {
  const client = await getClient(uri);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);
  const filter: any = { "target.uri": uri };
  if (q.status) {
    const arr = q.status.split(",").map(s => s.trim()).filter(Boolean);
    filter.status = { $in: arr };
  } else {
    // Por defecto filtramos elementos revertidos para mantener la vista limpia.
    filter.status = { $ne: "reverted" };
  }
  if (q.since) {
    const d = new Date(q.since);
    if (!isNaN(d.getTime())) filter.createdAt = { $gte: d };
  }
  const limit = Math.min(q.limit || 100, 500);
  const skip = q.skip || 0;
  const items = await audit.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).toArray();
  return { total: await audit.countDocuments(filter), items };
}

// Recupera un cambio puntual desde la auditoria.
export async function getChange(changeId: string, ctx: { uri: string }) {
  const client = await getClient(ctx.uri);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);
  return audit.find({ changeId, "target.uri": ctx.uri }).sort({ createdAt: -1 }).limit(1).next();
}
