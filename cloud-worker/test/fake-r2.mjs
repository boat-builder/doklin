// In-memory stand-ins for the two runtime bindings the worker touches: the
// R2 bucket (etags, conditional puts, listings, ranged gets) and the Workers
// cache (`caches.default`). Shared by cloud-worker/test/run.mjs and
// verify-harness/serve-worker.mjs, so the routes are exercised against one
// contract in both.
import { createHash } from "node:crypto";

export class FakeR2 {
  constructor() {
    this.store = new Map(); // key -> {bytes, etag, httpMetadata, customMetadata, uploaded}
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

  #object(key, rec, range) {
    // A ranged get answers the slice, as R2 does; the metadata stays whole.
    const bytes = range ? rec.bytes.subarray(range.offset ?? 0, (range.offset ?? 0) + (range.length ?? rec.bytes.length)) : rec.bytes;
    return {
      key,
      etag: rec.etag,
      httpEtag: `"${rec.etag}"`,
      size: rec.bytes.length,
      uploaded: rec.uploaded,
      httpMetadata: rec.httpMetadata,
      customMetadata: rec.customMetadata,
      body: new Uint8Array(bytes),
      json: async () => JSON.parse(bytes.toString("utf8")),
      text: async () => bytes.toString("utf8"),
      arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
    };
  }

  async put(key, value, opts = {}) {
    const cond = opts.onlyIf;
    if (cond?.etagMatches !== undefined) {
      const existing = this.store.get(key);
      if (!existing || existing.etag !== cond.etagMatches) return null;
    }
    // If-None-Match: "*" — create only when the object is absent.
    if (cond?.etagDoesNotMatch === "*" && this.store.has(key)) return null;
    const rec = this.#record(key, value, opts);
    this.store.set(key, rec);
    return this.#object(key, rec);
  }

  async get(key, opts = {}) {
    const rec = this.store.get(key);
    return rec ? this.#object(key, rec, opts.range) : null;
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

/** `caches.default`: what the worker put, keyed as it keyed it, and how often a key was served. */
export class FakeCache {
  constructor() {
    this.store = new Map();
    this.puts = [];
    this.hits = 0;
  }

  async match(key) {
    const rec = this.store.get(key);
    if (!rec) return undefined;
    this.hits += 1;
    return new Response(rec.body, { status: rec.status, headers: rec.headers });
  }

  async put(key, res) {
    this.puts.push(key);
    this.store.set(key, { body: await res.arrayBuffer(), status: res.status, headers: new Headers(res.headers) });
  }
}
