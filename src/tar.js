/**
 * Just enough of tar to read a GitHub source archive in the Worker.
 *
 * GitHub's archives are gzip-compressed POSIX tar with a pax global header
 * and one top-level directory named after the commit. Paths come back
 * relative to that directory. Regular files carry their bytes; links and
 * directories do not.
 */

const BLOCK = 512;
const decoder = new TextDecoder();

function text(bytes, start, length) {
  const slice = bytes.subarray(start, start + length);
  const end = slice.indexOf(0);
  return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
}

function octal(bytes, start, length) {
  const value = text(bytes, start, length).trim();
  if (!/^[0-7]*$/.test(value)) throw new Error("malformed tar size");
  return value ? parseInt(value, 8) : 0;
}

function paxPath(data) {
  let path = null;
  let offset = 0;
  const body = decoder.decode(data);
  while (offset < body.length) {
    const space = body.indexOf(" ", offset);
    if (space === -1) break;
    const length = Number(body.slice(offset, space));
    if (!Number.isSafeInteger(length) || length <= 0) break;
    const record = body.slice(space + 1, offset + length - 1);
    const equals = record.indexOf("=");
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
    offset += length;
  }
  return path;
}

export async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Entries `{ path, type: "file" | "directory" | "symlink", size, data }`. */
export function readTar(bytes) {
  const entries = [];
  let offset = 0;
  let longPath = null;
  while (offset + BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    const size = octal(header, 124, 12);
    const flag = String.fromCharCode(header[156] || 48);
    const data = bytes.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    if (flag === "g") continue;
    if (flag === "x") {
      longPath = paxPath(data) ?? longPath;
      continue;
    }
    if (flag === "L") {
      longPath = text(data, 0, data.length);
      continue;
    }
    const prefix = text(header, 345, 155);
    const name = longPath ?? (prefix ? `${prefix}/${text(header, 0, 100)}` : text(header, 0, 100));
    longPath = null;
    // Drop GitHub's single top-level directory.
    const slash = name.indexOf("/");
    const path = (slash === -1 ? "" : name.slice(slash + 1)).replace(/\/$/, "");
    if (!path) continue;
    const type = flag === "5" ? "directory" : flag === "2" ? "symlink"
      : flag === "0" || flag === "7" ? "file" : `other:${flag}`;
    entries.push({ path, type, size, data: type === "file" ? data : null });
  }
  return entries;
}

export async function readTarGz(bytes) {
  return readTar(await gunzip(bytes));
}
