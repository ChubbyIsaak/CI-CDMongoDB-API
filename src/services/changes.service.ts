import { MongoClient, Db } from "mongodb";
import { ChangeRequestSchema } from "../lib/validator";
import { newChangeId } from "../lib/ids";
import { getClient } from "./mongo.service";

const AUDIT_COLLECTION = "cicd_changes_audit";

type ApplyOptions = { dryRun?: boolean };
type BatchOptions = { stopOnError?: boolean; dryRun?: boolean };

function auditDb(client: MongoClient): Db {
  const dbName = process.env.AUDIT_DB || "admin";
  return client.db(dbName);
}

export async function applyChange(req: any, opts: ApplyOptions = {}) {
  const t0 = Date.now();
  const dryRun = !!opts.dryRun;
  const parsed = ChangeRequestSchema.parse(req);
  const changeId = parsed.changeId || newChangeId();

  const client = await getClient(parsed.target.uri);
  const db = client.db(parsed.target.database);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);

  let status: "applied" | "skipped" | "failed" = "applied";
  let message = "ok";
  let revertPlan: any = null;

  try {
    if (parsed.operation.type === "createCollection") {
      const name = parsed.operation.collection;
      const exists = (await db.listCollections({ name }).toArray()).length > 0;
      if (exists) {
        status = "skipped";
        message = "collection already exists";
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
          message = "index with same name and keys already exists";
        } else {
          throw new Error("index name exists with different keys");
        }
      } else {
        if (!dryRun) {
          await coll.createIndex(spec as any, { ...(options || {}), name });
        }
      }
      revertPlan = { type: "dropIndex", collection, name };
    } else {
      throw new Error("unsupported operation type");
    }

    // write audit unless dryRun
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
    if (!dryRun) {
      await audit.insertOne({
        changeId,
        target: parsed.target,
        operation: parsed.operation,
        metadata: parsed.metadata || {},
        status: "failed",
        message: String(err?.message || err),
        createdAt: new Date(),
      });
    }
    return { changeId, status: "failed", message: String(err?.message || err), durationMs: Date.now() - t0 };
  }
}

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
      // attempt compensating rollback for prior applied ones
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

export async function revertChange(changeId: string, ctx: { uri: string; database?: string }) {
  const client = await getClient(ctx.uri);
  const db = ctx.database ? client.db(ctx.database) : undefined;
  const audit = auditDb(client).collection(AUDIT_COLLECTION);

  // find most recent audit by changeId for this URI
  const rec = await audit.find({ changeId, "target.uri": ctx.uri }).sort({ createdAt: -1 }).limit(1).next();
  if (!rec) return { status: "failed", message: "changeId not found" };

  const targetDb = db || client.db(rec.target.database);

  if (rec.operation.type === "createIndex") {
    const { collection } = rec.operation;
    const name = rec.operation.options?.name || "idx_" + Object.keys(rec.operation.spec).join("_");
    try {
      await targetDb.collection(collection).dropIndex(name);
      await audit.updateOne({ _id: rec._id }, { $set: { revertedAt: new Date(), revertMessage: "index dropped", status: "reverted" } });
      return { status: "reverted", message: "index dropped" };
    } catch (err: any) {
      return { status: "failed", message: "dropIndex failed: " + String(err?.message || err) };
    }
  } else if (rec.operation.type === "createCollection") {
    const { collection } = rec.operation;
    const coll = targetDb.collection(collection);
    const count = await coll.countDocuments();
    if (count > 0) {
      return { status: "failed", message: "collection is not empty" };
    }
    try {
      await targetDb.dropCollection(collection);
      await audit.updateOne({ _id: rec._id }, { $set: { revertedAt: new Date(), revertMessage: "collection dropped", status: "reverted" } });
      return { status: "reverted", message: "collection dropped" };
    } catch (err: any) {
      return { status: "failed", message: "dropCollection failed: " + String(err?.message || err) };
    }
  } else {
    return { status: "failed", message: "unsupported revert type" };
  }
}

export async function listChanges(uri: string, q: { status?: string; since?: string; limit?: number; skip?: number }) {
  const client = await getClient(uri);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);
  const filter: any = { "target.uri": uri };
  if (q.status) {
    const arr = q.status.split(",").map(s => s.trim()).filter(Boolean);
    filter.status = { $in: arr };
  } else {
    // by default exclude reverted
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

export async function getChange(changeId: string, ctx: { uri: string }) {
  const client = await getClient(ctx.uri);
  const audit = auditDb(client).collection(AUDIT_COLLECTION);
  return audit.find({ changeId, "target.uri": ctx.uri }).sort({ createdAt: -1 }).limit(1).next();
}
