import { BROWSER_PREFLIGHT_POLICY } from "../browser/preflight.js";
import { inspectLeanSources, readLeanSource } from "../browser/lean-sources.js";

const TREE_BYTES = 2 * 1024 * 1024;
const SCAN_TIMEOUT_MS = 10_000;

/** Bounded convenience check; the complete checkout is checked by the verifier. */
export async function sourcePreflight(token, repository, commit) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SCAN_TIMEOUT_MS);
  const unavailable = { status: "incomplete", incomplete: true, diagnostics: [], files_checked: 0 };
  try {
    const response = await fetch(
      `https://api.github.com/repos/${repository}/git/trees/${commit}?recursive=1`,
      { signal: controller.signal, headers: {
        authorization: `Bearer ${token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "palomar-server",
      } },
    );
    const content = await readLeanSource(response, TREE_BYTES);
    if (!content?.complete) return unavailable;
    const tree = JSON.parse(content.text);
    if (!Array.isArray(tree.tree)) return unavailable;
    const result = await inspectLeanSources(tree.tree, async (entry, maximum) => {
      if (controller.signal.aborted) return null;
      const path = entry.path.split("/").map(encodeURIComponent).join("/");
      const raw = await fetch(`https://raw.githubusercontent.com/${repository}/${commit}/${path}`, {
        signal: controller.signal,
      });
      return readLeanSource(raw, maximum, entry.size);
    }, BROWSER_PREFLIGHT_POLICY);
    if (tree.truncated) {
      result.incomplete = true;
      if (result.status === "pass") result.status = "incomplete";
    }
    return result;
  } catch {
    return unavailable;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
