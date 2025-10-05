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
