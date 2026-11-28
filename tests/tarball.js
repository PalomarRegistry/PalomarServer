/**
 * Build GitHub-shaped source archives for tests: gzip, a pax global header,
 * and one top-level directory, with files, links and pax long paths.
 */
import { gzipSync } from "node:zlib";

function header(name, { size = 0, type = "0", link = "" } = {}) {
  const block = Buffer.alloc(512);
  block.write(name.slice(0, 100), 0, "utf8");
  block.write("0000644\0", 100);
  block.write("0000000\0", 108);
  block.write("0000000\0", 116);
  block.write(size.toString(8).padStart(11, "0") + "\0", 124);
  block.write("00000000000\0", 136);
  block.write("        ", 148);
  block.write(type, 156);
  block.write(link, 157);
  block.write("ustar\0", 257);
  block.write("00", 263);
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return block;
}

function padded(data) {
  const extra = (512 - (data.length % 512)) % 512;
  return Buffer.concat([data, Buffer.alloc(extra)]);
}

function pax(record) {
  // "<len> key=value\n", where len counts itself.
  let length = record.length + 3;
  while (`${length} ${record}\n`.length !== length) length += 1;
  return Buffer.from(`${length} ${record}\n`);
}

/** `entries`: { path: string | { link } }. */
export function githubTarball(entries, { root = "owner-project-cccccc" } = {}) {
  const parts = [];
  const global = pax(`comment=${"c".repeat(40)}`);
  parts.push(header("pax_global_header", { size: global.length, type: "g" }), padded(global));
  parts.push(header(`${root}/`, { type: "5" }));
  for (const [path, value] of Object.entries(entries)) {
    const name = `${root}/${path}`;
    if (name.length > 100) {
      const long = pax(`path=${name}`);
      parts.push(header("PaxHeader", { size: long.length, type: "x" }), padded(long));
    }
    if (typeof value === "object") {
      parts.push(header(name, { type: "2", link: value.link }));
    } else {
      const data = Buffer.from(value);
      parts.push(header(name, { size: data.length }), padded(data));
    }
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

/** The matching recursive tree, as the GitHub API returns it. */
export function githubTree(entries, extra = []) {
  return {
    truncated: false,
    tree: [
      ...Object.entries(entries).map(([path, value]) => typeof value === "object"
        ? { path, mode: "120000", type: "blob", size: value.link.length }
        : { path, mode: "100644", type: "blob", size: Buffer.byteLength(value) }),
      ...extra,
    ],
  };
}

export const PLAIN_PROJECT = {
  "lakefile.toml": "name = \"project\"\n",
  "lean-toolchain": "leanprover/lean4:v4.35.0\n",
  "comparator.json": JSON.stringify({ challenge_module: "Project.Challenge", solution_module: "Project.Solution" }),
  "Project/Challenge.lean": "theorem main : 1 + 1 = 2 := sorry\n",
  "Project/Solution.lean": "theorem main : 1 + 1 = 2 := rfl\n",
  "formalization.yaml": "title: test\n",
};
