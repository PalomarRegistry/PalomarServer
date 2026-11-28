/**
 * An in-memory R2 bucket with the conditional-write semantics the Worker
 * relies on (`etagMatches`, and `etagDoesNotMatch: "*"` for create-only),
 * checked against workerd in runtime-tests/confidential-store.test.js.
 */
export function fakeR2() {
  const objects = new Map();
  let version = 0;
  const log = [];
  function body(key) {
    const item = objects.get(key);
    if (!item) return null;
    const bytes = item.bytes;
    return {
      key,
      etag: item.etag,
      size: bytes.byteLength,
      async text() { return new TextDecoder().decode(bytes); },
      async json() { return JSON.parse(new TextDecoder().decode(bytes)); },
      async arrayBuffer() { return bytes.slice().buffer; },
    };
  }
  return {
    objects,
    log,
    async get(key) { log.push(`get ${key}`); return body(key); },
    async head(key) { log.push(`head ${key}`); return body(key); },
    async put(key, value, options = {}) {
      log.push(`put ${key}`);
      const current = objects.get(key);
      const condition = options.onlyIf ?? {};
      if (condition.etagMatches !== undefined && current?.etag !== condition.etagMatches) return null;
      if (condition.etagDoesNotMatch === "*" && current) return null;
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
      version += 1;
      const etag = `etag-${version}`;
      objects.set(key, { bytes, etag });
      return { key, etag };
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        log.push(`delete ${key}`);
        objects.delete(key);
      }
    },
    async list({ prefix = "", delimiter } = {}) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
      if (!delimiter) return { objects: keys.map((key) => ({ key })), truncated: false };
      const prefixes = new Set();
      const direct = [];
      for (const key of keys) {
        const rest = key.slice(prefix.length);
        const at = rest.indexOf(delimiter);
        if (at === -1) direct.push({ key });
        else prefixes.add(prefix + rest.slice(0, at + 1));
      }
      return { objects: direct, delimitedPrefixes: [...prefixes], truncated: false };
    },
  };
}
