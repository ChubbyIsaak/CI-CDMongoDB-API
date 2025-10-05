# setup_v4.ps1 - Bootstrap CICD Safe Changes API v4 (Windows, fresh install)
# This script creates a full TypeScript Express project with security hardening (JWT, HMAC, rate limit, IP allowlist),
# operational logs (NDJSON), ASCII-safe responses, change windows, and rich Swagger/Redoc docs.
# Run in an empty folder where you want to create the project.
# Usage:
#   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
#   .\setup_v4.ps1
#   npm run dev
$ErrorActionPreference = "Stop"

function Write-Info($msg) { Write-Host "[INFO] $msg" }

# 0) Initialize Node project if not exists
if (-not (Test-Path package.json)) {
  Write-Info "Initializing package.json"
  npm init -y | Out-Null
}

# 1) Dependencies
Write-Info "Installing dependencies"
npm i express pino dotenv mongodb zod jsonwebtoken helmet cors express-rate-limit ipaddr.js yaml redoc-express swagger-ui-express luxon | Out-Null
npm i -D typescript ts-node ts-node-dev @types/node @types/express @types/jsonwebtoken | Out-Null

# 2) Project structure
Write-Info "Creating folders"
mkdir -Force src, src\routes, src\controllers, src\services, src\lib, src\middleware, src\types, logs | Out-Null

# 3) package.json scripts
Write-Info "Updating package.json scripts"
$p = Get-Content package.json -Raw | ConvertFrom-Json
$p.scripts = @{
  dev   = "ts-node-dev --respawn --transpile-only src/index.ts"
  build = "tsc -p tsconfig.json"
  start = "node dist/index.js"
}
$p | ConvertTo-Json -Depth 100 | Set-Content -Encoding UTF8 package.json

# 4) tsconfig.json
@'
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "commonjs",
    "moduleResolution": "node",
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "resolveJsonModule": true,
    "rootDir": "src"
  },
  "include": ["src"]
}
'@ | Set-Content -Encoding UTF8 tsconfig.json

# 5) .env.example (v4)
@'
# v4 server configuration
PORT=8080
AUDIT_DB=admin

# Authentication (JWT)
JWT_REQUIRED=true
JWT_SECRET=

# HMAC signature for write operations (X-Signature = HMAC-SHA256 hex of raw JSON body)
HMAC_SECRET=

# Rate limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX=120

# IP allowlist (comma separated; supports CIDR). Empty = no filter
IP_ALLOWLIST=

# CORS (comma separated). Empty = *
CORS_ORIGINS=

# Operational logs
OPLOG_ENABLE=true
OPLOG_DIR=./logs

# Change window (optional). Example:
# CHANGE_ALLOW_WINDOW=Mon-Fri 07:00-19:00 America/Mexico_City, Sat 10:00-14:00 America/Mexico_City
CHANGE_ALLOW_WINDOW=
CHANGE_FREEZE_MESSAGE=Changes blocked by change window
CHANGE_BYPASS_TOKEN=

# Auto docs capture (dev only). 1 to enable express-oas-generator runtime
AUTO_DOCS=0

# Optional: restrict allowed MongoDB URIs for safety (regex)
ALLOW_TARGET_URI_REGEX=
'@ | Set-Content -Encoding UTF8 .env.example
if (-not (Test-Path ".env")) { Copy-Item ".env.example" ".env" -Force }

# 6) Type shim for ipaddr.js
@'
declare module "ipaddr.js" {
  export type Kind = "ipv4" | "ipv6";
  export interface IPAddress {
    kind(): Kind;
    toString(): string;
    toNormalizedString(): string;
    match(range: [IPAddress, number]): boolean;
    isIPv4MappedAddress?(): boolean;
    toIPv4Address?(): IPAddress;
  }
  export function parse(s: string): IPAddress;
  export function parseCIDR(s: string): [IPAddress, number];
}
'@ | Set-Content -Encoding UTF8 src\types\ipaddrjs.d.ts

# 7) Utility: ASCII-only JSON response for message/error
@'
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
'@ | Set-Content -Encoding UTF8 src\middleware\asciiResponse.ts

# 8) Security middlewares
@'
import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

export function authRequired() {
  const required = (process.env.JWT_REQUIRED || "true").toLowerCase() === "true";
  const secret = process.env.JWT_SECRET || "";
  return (req: Request, res: Response, next: NextFunction) => {
    if (!required) return next();
    if (!secret) return res.status(500).json({ error: "JWT required but JWT_SECRET not set" });
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    if (!token) return res.status(401).json({ error: "Missing bearer token" });
    try {
      const payload = jwt.verify(token, secret);
      (req as any).user = payload;
      return next();
    } catch {
      return res.status(401).json({ error: "Invalid token" });
    }
  };
}
'@ | Set-Content -Encoding UTF8 src\middleware\authRequired.ts

@'
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
'@ | Set-Content -Encoding UTF8 src\middleware\signature.ts

@'
import rateLimit from "express-rate-limit";
export function limiter() {
  const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS || "60000", 10);
  const max = parseInt(process.env.RATE_LIMIT_MAX || "120", 10);
  return rateLimit({ windowMs, max, legacyHeaders: false, standardHeaders: true });
}
'@ | Set-Content -Encoding UTF8 src\middleware\rateLimit.ts

@'
import { Request, Response, NextFunction } from "express";
import ipaddr from "ipaddr.js";

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

    if (!allowed) return res.status(403).json({ error: "IP not allowed" });
    next();
  };
}
'@ | Set-Content -Encoding UTF8 src\middleware\ipAllowlist.ts

# 9) Change window
@'
import { Request, Response, NextFunction } from "express";
import { DateTime } from "luxon";

type WindowDef = { days: number[]; start: string; end: string; tz: string };
const dayMap: Record<string, number> = { Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6, Sun:7 };

function parseWindows(raw?: string): WindowDef[] {
  if (!raw) return [];
  return raw.split(",").map(s => s.trim()).filter(Boolean).map(seg => {
    const m = seg.match(/^([A-Za-z*]{3})(?:-([A-Za-z*]{3}))?\s+(\d{2}:\d{2})-(\d{2}:\d{2})\s+([\w\/_+-]+)$/);
    if (!m) throw new Error(`Invalid window: ${seg}`);
    const [, d1, d2, start, end, tz] = m;
    const days: number[] = [];
    if (d1 === "*" || d2 === "*") { for (let i=1;i<=7;i++) days.push(i); }
    else if (d2) { const a = dayMap[d1], b = dayMap[d2]; for (let i=a;i<=b;i++) days.push(i); }
    else { const a = dayMap[d1]; days.push(a); }
    return { days, start, end, tz };
  });
}
function isAllowedNow(windows: WindowDef[]): boolean {
  if (!windows.length) return true;
  return windows.some(w => {
    const now = DateTime.now().setZone(w.tz);
    const dow = now.weekday;
    if (!w.days.includes(dow)) return false;
    const [sh, sm] = w.start.split(":").map(Number);
    const [eh, em] = w.end.split(":").map(Number);
    const start = now.set({ hour: sh, minute: sm, second:0, millisecond:0 });
    const end = now.set({ hour: eh, minute: em, second:0, millisecond:0 });
    return now >= start && now <= end;
  });
}
export function windowGuard() {
  const raw = process.env.CHANGE_ALLOW_WINDOW;
  const freezeMsg = process.env.CHANGE_FREEZE_MESSAGE || "Changes blocked by change window";
  let windows: WindowDef[] = [];
  try { windows = parseWindows(raw || ""); } catch { windows = []; }
  return (req: Request, res: Response, next: NextFunction) => {
    const bypassToken = process.env.CHANGE_BYPASS_TOKEN || "";
    const provided = ( req.headers["x-change-bypass"] || "" ) as string;
    if (bypassToken && provided && provided === bypassToken) return next();
    if (!isAllowedNow(windows)) return res.status(423).json({ error: freezeMsg, window: raw || "N/A" });
    next();
  };
}
'@ | Set-Content -Encoding UTF8 src\middleware\windowGuard.ts

# 10) Operational logger
@'
import pino from "pino";
import fs from "fs";
import path from "path";

let currentDate = "";
let logger: pino.Logger | null = null;

function roll() {
  const dir = process.env.OPLOG_DIR || "./logs";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const today = new Date().toISOString().slice(0,10).replace(/-/g,"");
  if (today !== currentDate || !logger) {
    currentDate = today;
    const file = path.join(dir, `ops-${today}.log`);
    const dest = pino.destination({ dest: file, append: true, sync: false });
    logger = pino({ level: "info" }, dest);
  }
}

export function opsLog(entry: Record<string, any>) {
  if ((process.env.OPLOG_ENABLE || "true").toLowerCase() !== "true") return;
  roll();
  logger!.info(entry);
}
'@ | Set-Content -Encoding UTF8 src\lib\ops-logger.ts

# 11) ID generator
@'
import crypto from "crypto";

export function newChangeId(): string {
  const d = new Date();
  const y = d.getUTCFullYear().toString();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  const rnd = crypto.randomBytes(4).toString("hex");
  return `chg-${y}${m}${day}-${rnd}`;
}
'@ | Set-Content -Encoding UTF8 src\lib\ids.ts

# 12) Validation schemas (Zod)
@'
import { z } from "zod";

export const TargetSchema = z.object({
  uri: z.string().min(1, "uri required"),
  database: z.string().min(1, "database required")
});

const PartialFilterAllowedOps = z.union([
  z.literal("$exists"),
  z.literal("$eq"),
  z.literal("$in"),
  z.literal("$gt"),
  z.literal("$gte"),
  z.literal("$lt"),
  z.literal("$lte"),
  z.literal("$ne"),
]);

export const CreateCollectionSchema = z.object({
  type: z.literal("createCollection"),
  collection: z.string().min(1),
  options: z.record(z.any()).optional()
});

export const CreateIndexSchema = z.object({
  type: z.literal("createIndex"),
  collection: z.string().min(1),
  spec: z.record(z.union([z.number(), z.literal(1), z.literal(-1)])).refine(v => Object.keys(v).length > 0, "spec required"),
  options: z.object({
    name: z.string().min(1),
    unique: z.boolean().optional(),
    partialFilterExpression: z.record(z.any()).optional()
  }).optional()
}).superRefine((data, ctx) => {
  const pfe = data.options?.partialFilterExpression as Record<string, any> | undefined;
  if (!pfe) return;
  const isAllowed = Object.values(pfe).every(v => {
    if (v && typeof v === "object") {
      const keys = Object.keys(v);
      return keys.every(k => PartialFilterAllowedOps.safeParse(k).success);
    }
    return true;
  });
  if (!isAllowed) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "partialFilterExpression contains disallowed operators" });
});

export const OperationSchema = z.discriminatedUnion("type", [
  CreateCollectionSchema,
  CreateIndexSchema
]);

export const ChangeRequestSchema = z.object({
  changeId: z.string().min(1).optional(),
  target: TargetSchema,
  operation: OperationSchema,
  metadata: z.record(z.any()).optional()
});
'@ | Set-Content -Encoding UTF8 src\lib\validator.ts

# 13) Mongo client service
@'
import { MongoClient } from "mongodb";

const clientCache = new Map<string, MongoClient>();

export async function getClient(uri: string): Promise<MongoClient> {
  const allow = process.env.ALLOW_TARGET_URI_REGEX;
  if (allow && !new RegExp(allow).test(uri)) {
    throw new Error("Target URI not allowed by ALLOW_TARGET_URI_REGEX");
  }
  let c = clientCache.get(uri);
  if (!c) {
    c = new MongoClient(uri, { retryWrites: true });
    await c.connect();
    clientCache.set(uri, c);
  }
  return c;
}
'@ | Set-Content -Encoding UTF8 src\services\mongo.service.ts

# 14) Changes service (core logic)
@'
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
'@ | Set-Content -Encoding UTF8 src\services\changes.service.ts

# 15) Controllers
@'
import { Request, Response } from "express";
import { ChangeRequestSchema } from "../lib/validator";
import { applyChange, applyBatch, revertChange, listChanges, getChange } from "../services/changes.service";
import { newChangeId } from "../lib/ids";
import { opsLog } from "../lib/ops-logger";

export async function applyChangeController(req: Request, res: Response) {
  if (!req.body?.changeId) req.body.changeId = newChangeId();
  const dryRun = (req.query.dryRun as string) === "true" || !!req.body?.dryRun;
  const parsed = ChangeRequestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

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
    dryRun: dryRun === true
  });

  const result = await applyChange(parsed.data, { dryRun });

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

export async function applyBatchController(req: Request, res: Response) {
  const { changes, stopOnError = true, dryRun = false } = req.body || {};
  if (!Array.isArray(changes) || changes.length === 0) {
    return res.status(400).json({ error: "changes array required" });
  }
  const parsed = changes.map((c: any) => {
    if (!c.changeId) c.changeId = newChangeId();
    const p = ChangeRequestSchema.safeParse(c);
    if (!p.success) return { error: p.error.flatten() };
    return p.data;
  });
  const invalid = parsed.find((x: any) => (x as any).error);
  if (invalid) return res.status(400).json({ error: (invalid as any).error });

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

  const result = await applyBatch(parsed as any[], { stopOnError, dryRun });

  opsLog({
    at: new Date().toISOString(),
    kind: "applyBatch.result",
    status: (result as any).status,
    failedAt: (result as any).failedAt
  });

  return res.json(result);
}

export async function revertChangeController(req: Request, res: Response) {
  const { changeId, uri, database } = req.body || {};
  if (!changeId || !uri) return res.status(400).json({ error: "changeId and uri are required" });

  const actor = (req as any).user || {};
  opsLog({
    at: new Date().toISOString(),
    kind: "revert",
    actor: { sub: actor.sub, email: actor.email },
    ip: (req.headers["x-forwarded-for"] as string)?.split(",")[0] || req.socket.remoteAddress,
    ua: req.headers["user-agent"],
    changeId, database
  });

  const result = await revertChange(changeId, { uri, database });

  opsLog({
    at: new Date().toISOString(),
    kind: "revert.result",
    changeId,
    status: (result as any).status,
    message: (result as any).message
  });

  return res.json(result);
}

export async function getChangeController(req: Request, res: Response) {
  const { changeId } = req.params;
  const uri = (req.query.uri as string) || (req.body?.target?.uri as string);
  if (!uri) return res.status(400).json({ error: "missing ?uri=" });
  const result = await getChange(changeId, { uri });
  if (!result) return res.status(404).json({ error: "not found" });
  return res.json(result);
}

export async function listPendingController(req: Request, res: Response) {
  const uri = req.query.uri as string;
  if (!uri) return res.status(400).json({ error: "missing ?uri=" });
  const onlyApplied = (req.query.onlyApplied as string) === "true";
  const status = (req.query.status as string) || (onlyApplied ? "applied" : undefined);
  const since = req.query.since as string | undefined;
  const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);
  const skip = parseInt((req.query.skip as string) || "0", 10);
  const result = await listChanges(uri, { status, since, limit, skip });
  return res.json(result);
}
'@ | Set-Content -Encoding UTF8 src\controllers\changes.controller.ts

# 16) Routes
@'
import { Router } from "express";
import {
  applyBatchController,
  applyChangeController,
  getChangeController,
  listPendingController,
  revertChangeController,
} from "../controllers/changes.controller";
import { windowGuard } from "../middleware/windowGuard";
import { verifySignature } from "../middleware/signature";
import { limiter } from "../middleware/rateLimit";

export const router = Router();

// Write endpoints: signature -> rate limit -> window guard
router.post("/apply", verifySignature(), limiter(), windowGuard(), applyChangeController);
router.post("/apply-batch", verifySignature(), limiter(), windowGuard(), applyBatchController);
router.post("/revert", verifySignature(), limiter(), revertChangeController);

// Read endpoints
router.get("/:changeId", getChangeController);
router.get("/", listPendingController);
router.get("/pending", listPendingController);
'@ | Set-Content -Encoding UTF8 src\routes\changes.routes.ts

# 17) Docs router (Swagger UI + Redoc)
@'
import { Router } from "express";
import swaggerUi from "swagger-ui-express";
import fs from "fs";
import path from "path";
import * as YAML from "yaml";

export function docsRouter(): Router {
  const r = Router();
  const specPath = path.join(process.cwd(), "openapi.yaml");
  const swaggerDoc = fs.existsSync(specPath)
    ? YAML.parse(fs.readFileSync(specPath, "utf8"))
    : { openapi: "3.0.0", info: { title: "CICD Safe Changes API", version: "v4" } };
  r.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerDoc, { explorer: true }));
  r.get("/docs.json", (_req, res) => res.json(swaggerDoc));
  r.get("/redoc", (_req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html><head><title>API Docs</title>
    <meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1">
    <script src="https://cdn.redoc.ly/redoc/latest/bundles/redoc.standalone.js"></script></head>
    <body><redoc spec-url="/docs.json"></redoc></body></html>`);
  });
  return r;
}
'@ | Set-Content -Encoding UTF8 src\middleware\docs.ts

# 18) Index
@'
import "dotenv/config";
import express from "express";
import pino from "pino";
import helmet from "helmet";
import cors from "cors";
import { router as changesRouter } from "./routes/changes.routes";
import { authRequired } from "./middleware/authRequired";
import { limiter } from "./middleware/rateLimit";
import { ipAllowlist } from "./middleware/ipAllowlist";
import { asciiResponse } from "./middleware/asciiResponse";
import { docsRouter } from "./middleware/docs";

const PORT = parseInt(process.env.PORT || "8080", 10);
const logger = pino({ level: process.env.LOG_LEVEL || "info" });

const app = express();
app.use(helmet());
app.use(cors({
  origin: (process.env.CORS_ORIGINS || "*").split(",").map(s => s.trim()).filter(Boolean),
}));
app.use(express.json({ limit: "256kb" }));
app.use(asciiResponse());
app.use(ipAllowlist());
app.use(authRequired());
app.use(limiter());

if ((process.env.AUTO_DOCS || "0") === "1") {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const oas = require("express-oas-generator");
  oas.init(app, {});
}

// basic access log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    logger.info({ method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - t0 });
  });
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true, version: "v4" }));
app.use("/changes", changesRouter);
app.use("/", docsRouter());

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ err }, "Unhandled error");
  res.status(err?.status || 500).json({ error: "Internal Server Error" });
});

app.listen(PORT, () => logger.info({ PORT }, "API v4 listening"));
'@ | Set-Content -Encoding UTF8 src\index.ts

# 19) OpenAPI (rich docs)
@'
openapi: 3.0.3
info:
  title: CICD Safe Changes API
  version: v4
  description: >
    API for safe, idempotent schema changes in MongoDB (createCollection, createIndex) with auditing, dry-run,
    batch with compensating rollback, and safe revert by changeId.
servers:
  - url: http://localhost:{port}
    variables:
      port:
        default: "8080"
tags:
  - name: Health
  - name: Changes
    description: Change operations and audit
components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
  parameters:
    UriParam:
      in: query
      name: uri
      required: true
      schema: { type: string }
      description: MongoDB connection string to the replica set
  schemas:
    Target:
      type: object
      required: [uri, database]
      properties:
        uri: { type: string, example: mongodb://user:pass@127.0.0.1:27000,127.0.0.1:27001,127.0.0.1:27002/?replicaSet=rs0&authSource=admin }
        database: { type: string, example: MyDB }
    CreateCollection:
      type: object
      required: [type, collection]
      properties:
        type: { type: string, enum: [createCollection] }
        collection: { type: string, example: users }
        options: { type: object, additionalProperties: true }
    CreateIndex:
      type: object
      required: [type, collection, spec]
      properties:
        type: { type: string, enum: [createIndex] }
        collection: { type: string, example: users }
        spec:
          type: object
          additionalProperties: [number, integer]
          example: { email: 1 }
        options:
          type: object
          properties:
            name: { type: string, example: ix_email_unique }
            unique: { type: boolean, example: true }
            partialFilterExpression:
              type: object
              additionalProperties: true
    Operation:
      oneOf:
        - $ref: "#/components/schemas/CreateCollection"
        - $ref: "#/components/schemas/CreateIndex"
    ChangeRequest:
      type: object
      properties:
        changeId: { type: string, description: Optional. If not provided, server generates one. }
        target: { $ref: "#/components/schemas/Target" }
        operation: { $ref: "#/components/schemas/Operation" }
        metadata: { type: object, additionalProperties: true }
    ChangeResult:
      type: object
      properties:
        changeId: { type: string }
        status: { type: string, enum: [applied, skipped, failed, reverted, ok, rolled_back] }
        message: { type: string }
        revertPlan: { type: object, additionalProperties: true }
        durationMs: { type: integer }
paths:
  /health:
    get:
      tags: [Health]
      summary: Health check
      responses:
        "200":
          description: OK
  /changes/apply:
    post:
      tags: [Changes]
      summary: Apply a single change
      description: >
        Supports dryRun via query param. Valid operations: createCollection, createIndex.
        If changeId is omitted, server generates one and returns it.
      security: [ { bearerAuth: [] } ]
      parameters:
        - in: query
          name: dryRun
          schema: { type: boolean }
          description: If true, validates and returns plan without touching MongoDB or audit
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: "#/components/schemas/ChangeRequest" }
            examples:
              createIndex:
                value:
                  target:
                    uri: mongodb://user:pass@127.0.0.1:27000,127.0.0.1:27001,127.0.0.1:27002/?replicaSet=rs0&authSource=admin
                    database: MyDB
                  operation:
                    type: createIndex
                    collection: users
                    spec: { email: 1 }
                    options: { name: ix_email_unique, unique: true }
      responses:
        "200":
          description: Result
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ChangeResult" }
  /changes/apply-batch:
    post:
      tags: [Changes]
      summary: Apply a batch of changes
      description: >
        Applies multiple changes sequentially. If any fails and stopOnError is true, previously applied changes are reverted.
        Supports dryRun.
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              properties:
                stopOnError: { type: boolean, default: true }
                dryRun: { type: boolean, default: false }
                changes:
                  type: array
                  items: { $ref: "#/components/schemas/ChangeRequest" }
      responses:
        "200":
          description: Result
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ChangeResult" }
  /changes/revert:
    post:
      tags: [Changes]
      summary: Revert a change by changeId
      description: >
        Reverts the most recent audit record for the provided changeId and uri.
        Database param is optional; if omitted, audit record database is used.
      security: [ { bearerAuth: [] } ]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [changeId, uri]
              properties:
                changeId: { type: string }
                uri: { type: string }
                database: { type: string }
      responses:
        "200":
          description: Result
          content:
            application/json:
              schema: { $ref: "#/components/schemas/ChangeResult" }
  /changes:
    get:
      tags: [Changes]
      summary: List changes with filters
      description: >
        Default behavior excludes reverted. Use status=applied,failed,skipped,reverted to filter.
      security: [ { bearerAuth: [] } ]
      parameters:
        - $ref: "#/components/parameters/UriParam"
        - in: query
          name: status
          schema: { type: string }
          description: Comma separated statuses
        - in: query
          name: since
          schema: { type: string }
          description: ISO-8601 date filter for createdAt
        - in: query
          name: limit
          schema: { type: integer, default: 100 }
        - in: query
          name: skip
          schema: { type: integer, default: 0 }
      responses:
        "200":
          description: Result
  /changes/{changeId}:
    get:
      tags: [Changes]
      summary: Get a change by changeId
      security: [ { bearerAuth: [] } ]
      parameters:
        - in: path
          name: changeId
          required: true
          schema: { type: string }
        - $ref: "#/components/parameters/UriParam"
      responses:
        "200":
          description: Result
'@ | Set-Content -Encoding UTF8 openapi.yaml

# 20) README quick start
@'
# CICD Safe Changes API v4

Fresh TypeScript Express API for "safe" schema changes in MongoDB. Includes:
- JWT auth (HS256) and optional HMAC body signature for write operations
- Rate limit, Helmet, CORS, IP allowlist
- Change window guard with optional bypass header
- ASCII-only response sanitation for message/error
- NDJSON operational logs per day
- Swagger UI (/docs) and Redoc (/redoc)
- Idempotent createCollection/createIndex, audit log, revert by changeId, dry-run, batch with rollback

## Quick start
1) Copy .env.example to .env and set secrets.
2) npm run dev
3) Open http://localhost:8080/docs

## JWT token for tests
Install jsonwebtoken and run:
```
npm i jsonwebtoken
$env:JWT_SECRET="<same_as_.env>"
node -e "const jwt=require('jsonwebtoken');console.log(jwt.sign({sub:'user-1',email:'dev@local'},process.env.JWT_SECRET,{algorithm:'HS256',expiresIn:'1h'}));"
```
'@ | Set-Content -Encoding UTF8 README.md

Write-Info "Done. Edit .env, then run: npm run dev"
