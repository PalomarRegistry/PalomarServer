// Preliminary source checks shared by the browser and HTTPS intake.
// The verifier scans the complete immutable checkout and confirms headers with Lean.
export const SOURCE_SCAN_FILES = 32;
export const SOURCE_SCAN_BYTES = 4 * 1024 * 1024;
export const SOURCE_SCAN_FILE_BYTES = 1024 * 1024;

export function isLeanSourcePath(path, policy) {
  const parts = path.split("/");
  return path.endsWith(".lean") &&
    !parts.some((part) => policy.lean_sources.excluded_directories.includes(part));
}

// Lean 4 Init/Meta/Defs.lean identifier characters; Unicode letter classes
// are broader. A qualified identifier also continues across a dot.
const ID_LETTER_LIKE =
  String.raw`\u03b1-\u03ba\u03bc-\u03c9\u0391-\u039f\u03a1-\u03a2\u03a4-\u03a9` +
  String.raw`\u03ca-\u03fb\u1f00-\u1ffe\u2100-\u214f\u{1d49c}-\u{1d59f}` +
  String.raw`\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u017f`;
const ID_FIRST = `A-Za-z_${ID_LETTER_LIKE}`;
const ID_REST = ID_FIRST + String.raw`0-9'!?\u2080-\u2089\u2090-\u209c\u1d62-\u1d6a\u2c7c`;
const IDENTIFIER_CONTINUATION = new RegExp(String.raw`^(?:[${ID_REST}]|\.[${ID_FIRST}«])`, "u");

export function moduleHeader(text, complete = true) {
  let index = 0;
  while (index < text.length) {
    if (" \r\n".includes(text[index])) index += 1;
    else if (text.startsWith("--", index)) {
      const end = text.indexOf("\n", index + 2);
      if (end < 0) return complete ? "missing" : "incomplete";
      index = end + 1;
    } else if (text.startsWith("/-", index) &&
        !text.startsWith("/--", index) && !text.startsWith("/-!", index)) {
      // Lean consumes one character after a plain opener, then scans markers.
      index += 3;
      let depth = 1;
      const markers = /\/-|-\//g;
      markers.lastIndex = index;
      let marker;
      while (depth && (marker = markers.exec(text)) !== null) {
        depth += marker[0] === "/-" ? 1 : -1;
        index = markers.lastIndex;
      }
      if (depth) return complete ? "missing" : "incomplete";
    } else {
      const rest = text.slice(index);
      if (!complete && ("module".startsWith(rest) || rest === "module/" || rest === "module-" || rest === "module." ||
          rest === "/" || rest === "-")) {
        return "incomplete";
      }
      return rest.startsWith("module") && (
        !IDENTIFIER_CONTINUATION.test(rest.slice(6))
      ) ? "present" : "missing";
    }
  }
  return complete ? "missing" : "incomplete";
}

export function validateLeanSource(path, text, policy, { complete = true } = {}) {
  const diagnostics = [];
  const lines = (text.match(/\n/g) || []).length +
    Number(complete && text.length > 0 && !text.endsWith("\n"));
  if (lines > policy.limits.lean_source_lines) {
    diagnostics.push({
      code: "source.file_too_long", path,
      summary: `${path} has ${complete ? "" : "at least "}${lines.toLocaleString("en-US")} lines; each submitted Lean source file must have at most ${policy.limits.lean_source_lines.toLocaleString("en-US")} lines. Split the source into smaller modules or reduce the certificate.`,
    });
  }
  if (!policy.lean_sources.module_exempt_filenames.includes(path.split("/").at(-1)) &&
      moduleHeader(text, complete) === "missing") {
    diagnostics.push({
      code: "source.module_required", path,
      summary: `${path} must begin with the module header keyword. Port the file to the module system, including public declarations/imports and exposed definitions as needed.`,
    });
  }
  return diagnostics;
}

/** Read a bounded prefix without buffering an unbounded raw response. */
export async function readLeanSource(response, maximumBytes, expectedBytes) {
  if (!response.ok || !response.body) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  let ended = false;
  let received = 0;
  try {
    while (length < maximumBytes) {
      const { done, value } = await reader.read();
      if (done) { ended = true; break; }
      received += value.length;
      const kept = value.subarray(0, maximumBytes - length);
      chunks.push(kept);
      length += kept.length;
      if (kept.length !== value.length) break;
    }
    // A declared Git blob size is not proof that the HTTP body ended. Reject
    // extra chunks instead of turning a bounded prefix into a complete read.
    if (
      !ended && Number.isSafeInteger(expectedBytes) &&
      received === expectedBytes && length === expectedBytes
    ) {
      const tail = await reader.read();
      if (!tail.done) return null;
      ended = true;
    }
  } finally {
    await reader.cancel();
  }
  const knownSize = Number.isSafeInteger(expectedBytes);
  if (knownSize && received > expectedBytes) return null;
  const complete = ended;
  if (complete && knownSize && length !== expectedBytes) return null;
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    // Preserve a BOM: Lean does not recognize a module header after one.
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(bytes, { stream: !complete });
    return { text, complete };
  } catch {
    return null;
  }
}

export async function inspectLeanSources(entries, read, policy) {
  const files = entries.filter((entry) => entry.type === "blob" &&
    (/^100\d{3}$/.test(entry.mode || "") || entry.mode === "120000") &&
    isLeanSourcePath(entry.path, policy))
    .sort((left, right) => right.size - left.size || left.path.localeCompare(right.path));
  const diagnostics = [];
  let budget = SOURCE_SCAN_BYTES;
  let checked = 0;
  let incomplete = files.length > SOURCE_SCAN_FILES;
  for (const entry of files.slice(0, SOURCE_SCAN_FILES)) {
    if (entry.mode === "120000") {
      checked += 1;
      diagnostics.push({ code: "source.symlink_not_allowed", path: entry.path,
        summary: `${entry.path} must be a regular Lean file, not a symbolic link. Commit the source as a regular .lean file and submit the new commit.` });
      continue;
    }
    if (!Number.isSafeInteger(entry.size) || entry.size < 0 || budget <= 0) {
      incomplete = true;
      continue;
    }
    const maximum = Math.min(budget, SOURCE_SCAN_FILE_BYTES, Math.max(entry.size, 1));
    budget -= maximum;
    let content;
    try { content = await read(entry, maximum); } catch { content = null; }
    if (content === null) { incomplete = true; continue; }
    checked += 1;
    incomplete ||= !content.complete;
    diagnostics.push(...validateLeanSource(entry.path, content.text, policy, content));
  }
  return {
    status: diagnostics.length ? "fail" : incomplete ? "incomplete" : "pass",
    incomplete, diagnostics, files_checked: checked, total_files: files.length,
  };
}
