import http, { IncomingHttpHeaders } from "http";
import https from "https";
import { URL } from "url";

export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

export interface HttpResponse {
  statusCode: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function httpRequest(url: string, options: HttpRequestOptions = {}): Promise<HttpResponse> {
  const parsedUrl = new URL(url);
  const isHttps = parsedUrl.protocol === "https:";
  const requester = isHttps ? https.request : http.request;
  const method = options.method || "GET";
  const headers = options.headers || {};
  const body = options.body;
  const timeout = options.timeoutMs ?? 15000;
  const port = parsedUrl.port ? parseInt(parsedUrl.port, 10) : (isHttps ? 443 : 80);
  const pathWithQuery = parsedUrl.pathname + parsedUrl.search;

  const requestOptions: https.RequestOptions = {
    method,
    headers,
    hostname: parsedUrl.hostname,
    port,
    path: pathWithQuery,
  };

  return new Promise<HttpResponse>((resolve, reject) => {
    const req = requester(requestOptions, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
      });
    });

    req.on("error", reject);
    req.setTimeout(timeout, () => {
      req.destroy(new Error("Request to " + url + " timed out after " + timeout + "ms"));
    });

    if (body) {
      req.write(body);
    }
    req.end();
  });
}

export function toBasicAuth(username: string, password: string): string {
  return Buffer.from(username + ":" + password).toString("base64");
}
