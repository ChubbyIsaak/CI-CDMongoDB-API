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
