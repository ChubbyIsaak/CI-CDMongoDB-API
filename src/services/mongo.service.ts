import { MongoClient } from "mongodb";

const clientCache = new Map<string, MongoClient>();

// Este helper entrega un cliente Mongo reutilizable para la URI solicitada.
export async function getClient(uri: string): Promise<MongoClient> {
  const allow = process.env.ALLOW_TARGET_URI_REGEX;
  if (allow && !new RegExp(allow).test(uri)) {
    throw new Error("The provided MongoDB URI does not match ALLOW_TARGET_URI_REGEX.");
  }
  let c = clientCache.get(uri);
  if (!c) {
    c = new MongoClient(uri, { retryWrites: true });
    await c.connect();
    clientCache.set(uri, c);
  }
  return c;
}
