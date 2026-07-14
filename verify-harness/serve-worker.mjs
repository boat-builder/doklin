// Serves the share worker over plain node http so a real browser can walk
// the public pages (gate → unlock → comment). In-memory R2 fake (the same
// contract share-worker/test/run.mjs fakes); state resets on restart.
//
//   node verify-harness/serve-worker.mjs   # http://localhost:8787, owner token "owner-secret"
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import worker from "../share-worker/src/index.js";

class FakeR2 {
  constructor() {
    this.store = new Map();
  }
  #record(key, value, opts = {}) {
    const bytes =
      typeof value === "string"
        ? Buffer.from(value, "utf8")
        : value instanceof ArrayBuffer
          ? Buffer.from(new Uint8Array(value))
          : Buffer.from(value);
    return {
      bytes,
      etag: createHash("md5").update(bytes).update(key).digest("hex"),
      httpMetadata: opts.httpMetadata ?? {},
      customMetadata: opts.customMetadata ?? {},
      uploaded: new Date(),
    };
  }
  #object(key, rec) {
    return {
      key,
      etag: rec.etag,
      httpEtag: `"${rec.etag}"`,
      size: rec.bytes.length,
      uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata,
      customMetadata: rec.customMetadata,
      body: new Uint8Array(rec.bytes),
      json: async () => JSON.parse(rec.bytes.toString("utf8")),
      text: async () => rec.bytes.toString("utf8"),
      arrayBuffer: async () =>
        rec.bytes.buffer.slice(rec.bytes.byteOffset, rec.bytes.byteOffset + rec.bytes.length),
    };
  }
  async put(key, value, opts = {}) {
    if (opts.onlyIf?.etagMatches !== undefined) {
      const existing = this.store.get(key);
      if (!existing || existing.etag !== opts.onlyIf.etagMatches) return null;
    }
    const rec = this.#record(key, value, opts);
    this.store.set(key, rec);
    return this.#object(key, rec);
  }
  async get(key) {
    const rec = this.store.get(key);
    return rec ? this.#object(key, rec) : null;
  }
  async head(key) {
    const rec = this.store.get(key);
    if (!rec) return null;
    const { body, json, text, arrayBuffer, ...meta } = this.#object(key, rec);
    return meta;
  }
  async delete(keys) {
    for (const k of Array.isArray(keys) ? keys : [keys]) this.store.delete(k);
  }
  async list({ prefix = "", cursor, delimiter, limit = 1000 } = {}) {
    const keys = [...this.store.keys()].filter((k) => k.startsWith(prefix)).sort();
    if (delimiter) {
      const delimitedPrefixes = [];
      const objects = [];
      for (const k of keys) {
        const rest = k.slice(prefix.length);
        const idx = rest.indexOf(delimiter);
        if (idx >= 0) {
          const p = prefix + rest.slice(0, idx + 1);
          if (!delimitedPrefixes.includes(p)) delimitedPrefixes.push(p);
        } else {
          objects.push(this.#object(k, this.store.get(k)));
        }
      }
      return { objects, delimitedPrefixes, truncated: false };
    }
    const start = cursor ? Number(cursor) : 0;
    const page = keys.slice(start, start + limit);
    const truncated = start + limit < keys.length;
    return {
      objects: page.map((k) => this.#object(k, this.store.get(k))),
      truncated,
      cursor: truncated ? String(start + limit) : undefined,
      delimitedPrefixes: [],
    };
  }
}

const env = { SHARE_TOKEN: "owner-secret", PAGES: new FakeR2() };
const PORT = Number(process.env.PORT || 8787);

createServer(async (req, res) => {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
    else if (Array.isArray(v)) for (const one of v) headers.append(k, one);
  }
  const request = new Request(`http://localhost:${PORT}${req.url}`, {
    method: req.method,
    headers,
    ...(body.length > 0 ? { body, duplex: "half" } : {}),
  });
  let response;
  try {
    response = await worker.fetch(request, env);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e?.stack || e));
    return;
  }
  const out = {};
  const setCookies = response.headers.getSetCookie?.() ?? [];
  response.headers.forEach((v, k) => {
    if (k !== "set-cookie") out[k] = v;
  });
  res.writeHead(response.status, { ...out, ...(setCookies.length ? { "set-cookie": setCookies } : {}) });
  res.end(Buffer.from(await response.arrayBuffer()));
}).listen(PORT, () => console.log(`share worker on http://localhost:${PORT}`));
