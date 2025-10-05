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
