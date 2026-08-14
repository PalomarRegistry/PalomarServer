import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { IDENTIFYING_FIELDS } from "../src/admission-contract.js";
import { digest } from "../src/submission.js";

const run = promisify(execFile);
const tool = (name) => resolve(import.meta.dirname, "..", "tools", name);

// One digest vector, shared with the Worker's own path construction in
// `src/index.js`, so a tool that drifts from intake fails here rather than
// sending an operator to a file that does not exist.
const PEPPER = "test-pepper";
const ID = "4242";

async function workerRatePath(pepper, id) {
  return `index/rate/${await digest(`${pepper}:${id}`)}.json`;
}

async function attempt(file, args, options = {}) {
  try {
    const { stdout, stderr } = await run(file, args, options);
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;

function rateDocument(overrides = {}) {
  return {
    schema_version: 1,
    starts: 3,
    interval_seconds: 240,
    last_start_at: "2026-08-07T00:00:00Z",
    next_allowed_at: "2026-08-07T00:04:00Z",
    ...overrides,
  };
}

async function stateRepository(files) {
  const root = await mkdtemp(join(tmpdir(), "palomar-state-"));
  const directory = join(root, "index", "rate");
  await mkdir(directory, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(join(directory, name), contents);
  }
  return { root, directory };
}

test("rate-path prints exactly the path the Worker would have written", async () => {
  const { stdout } = await run(tool("rate-path.js"), ["--id", ID], {
    env: { ...process.env, TOKEN_PEPPER: PEPPER },
  });
  assert.equal(stdout.trim(), await workerRatePath(PEPPER, ID));
  // The digest must actually depend on the pepper, or the scheme is decoration.
  const other = await run(tool("rate-path.js"), ["--id", ID], {
    env: { ...process.env, TOKEN_PEPPER: "another-pepper" },
  });
  assert.notEqual(other.stdout.trim(), stdout.trim());
  assert.equal(other.stdout.trim(), await workerRatePath("another-pepper", ID));

  // Splitting a flag on `=` is what makes `--pepper=secret` refusable, so the
  // spelling has to keep working for the flags that are allowed.
  const joined = await run(tool("rate-path.js"), [`--id=${ID}`], {
    env: { ...process.env, TOKEN_PEPPER: PEPPER },
  });
  assert.equal(joined.stdout.trim(), stdout.trim());
});

test("rate-path takes its pepper only from the environment", async () => {
  const withheld = { ...process.env };
  delete withheld.TOKEN_PEPPER;
  const missing = await attempt(tool("rate-path.js"), ["--id", ID], { env: withheld });
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /set TOKEN_PEPPER in the environment/);

  // A pepper on the command line reaches the process list and the shell
  // history, so the argument is refused rather than quietly honoured. Both
  // spellings, and neither refusal may echo the value back: printing it to the
  // terminal is most of what the argument was refused for.
  for (const args of [
    ["--id", ID, "--pepper", "secret-pepper"],
    ["--id", ID, "--pepper=secret-pepper"],
    ["--pepper=secret-pepper"],
    ["--pepper=secret-pepper", "--id", ID],
  ]) {
    const argument = await attempt(tool("rate-path.js"), args, { env: withheld });
    assert.equal(argument.code, 2, `${args} was not refused`);
    assert.match(argument.stderr, /--pepper is not supported/);
    assert.doesNotMatch(
      `${argument.stdout}${argument.stderr}`,
      /secret-pepper/,
      `${args} echoed the pepper back`,
    );
  }
});

test("no rate-path failure path echoes an argument value", async () => {
  // A typo that puts the pepper in some other flag's value must not be
  // answered by printing it, so the parser reports flag names and never
  // values. `--peppr=` is the near miss that a bare unknown-argument message
  // would have leaked.
  const withheld = { ...process.env };
  delete withheld.TOKEN_PEPPER;
  for (const args of [
    ["--peppr=secret-pepper"],
    ["--unknown", "secret-pepper"],
    ["secret-pepper"],
    ["--login=secret-pepper!"],
    ["--id=secret-pepper"],
  ]) {
    const { code, stdout, stderr } = await attempt(tool("rate-path.js"), args, {
      env: { ...withheld, TOKEN_PEPPER: PEPPER },
    });
    assert.equal(code, 2, `${args} was not refused`);
    assert.doesNotMatch(`${stdout}${stderr}`, /secret-pepper/, `${args} echoed a value`);
  }
});

test("rate-path never prints the pepper, even while failing", async () => {
  const environment = { ...process.env, TOKEN_PEPPER: "secret-pepper" };
  for (const args of [["--id", "0"], ["--id", "abc"], ["--login", "not a login"], ["--wat", "x"]]) {
    const { stdout, stderr } = await attempt(tool("rate-path.js"), args, { env: environment });
    assert.doesNotMatch(`${stdout}${stderr}`, /secret-pepper/, `${args} leaked the pepper`);
  }
});

test("rate-path requires a canonical positive safe-integer id", async () => {
  const environment = { ...process.env, TOKEN_PEPPER: PEPPER };
  for (const id of [
    "0",
    "-1",
    "0042",
    "4242.0",
    "4e3",
    " 4242",
    "9007199254740993",
    "123456789012345678901234567890",
  ]) {
    const { code, stderr } = await attempt(tool("rate-path.js"), ["--id", id], {
      env: environment,
    });
    assert.equal(code, 2, `${id} was accepted as a GitHub id`);
    assert.match(stderr, /canonical positive safe-integer GitHub id/);
  }
  const highest = String(Number.MAX_SAFE_INTEGER);
  const { stdout } = await run(tool("rate-path.js"), ["--id", highest], { env: environment });
  assert.equal(stdout.trim(), await workerRatePath(PEPPER, highest));
});

test("rate-path resolves a login without handing the pepper to gh", async () => {
  // A stub `gh` that reports whether it inherited the deployment's pepper, so
  // this is a fact about the spawned process rather than about our intentions.
  const bin = await mkdtemp(join(tmpdir(), "palomar-bin-"));
  await writeFile(
    join(bin, "gh"),
    "#!/bin/sh\nif [ -n \"$TOKEN_PEPPER\" ]; then echo 'INHERITED' >&2; exit 1; fi\necho 4242\n",
  );
  await chmod(join(bin, "gh"), 0o755);
  const { stdout, stderr } = await run(tool("rate-path.js"), ["--login", "someone"], {
    env: { ...process.env, TOKEN_PEPPER: PEPPER, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.doesNotMatch(stderr, /INHERITED/, "gh inherited TOKEN_PEPPER");
  assert.equal(stdout.trim(), await workerRatePath(PEPPER, ID));
});

test("strip-rate-logins reports before it writes, and writes only when asked", async () => {
  const legacy = canonical(rateDocument({ login: "someone" }));
  const { root, directory } = await stateRepository({ "aaa.json": legacy });

  const dry = await run(tool("strip-rate-logins.js"), [root]);
  assert.match(dry.stdout, /carries login in index\/rate\/aaa\.json/);
  assert.match(dry.stdout, /1 of 1 rate documents can be rewritten/);
  assert.match(dry.stdout, /re-run with --write/);
  assert.equal(await readFile(join(directory, "aaa.json"), "utf8"), legacy, "a dry run wrote");

  const written = await run(tool("strip-rate-logins.js"), [root, "--write"]);
  assert.match(written.stdout, /rewrote login in index\/rate\/aaa\.json/);
  assert.deepEqual(
    JSON.parse(await readFile(join(directory, "aaa.json"), "utf8")),
    rateDocument(),
  );
});

test("strip-rate-logins removes the identifying fields and nothing else", async () => {
  // The tool is deliberately not the validator: it edits files the Worker may
  // never have written, so it removes the fields it was asked to remove and
  // leaves everything else exactly as it found it, including a field the
  // contract would now refuse. That is the property a migration wants.
  const extended = rateDocument({
    login: "someone",
    submission_ids: ["abcdefghijkl"],
    producer_extension: { retained: true, nested: [1, 2, { deep: "value" }] },
  });
  const { root, directory } = await stateRepository({ "aaa.json": canonical(extended) });
  await run(tool("strip-rate-logins.js"), [root, "--write"]);

  const after = JSON.parse(await readFile(join(directory, "aaa.json"), "utf8"));
  assert.deepEqual(after, rateDocument({
    producer_extension: { retained: true, nested: [1, 2, { deep: "value" }] },
  }));
  for (const field of IDENTIFYING_FIELDS) {
    assert.equal(Object.hasOwn(after, field), false, `${field} survived`);
  }
});

test("strip-rate-logins refuses documents a rewrite would silently reformat", async () => {
  // Each of these parses, and each would come back from a reserialization as
  // different bytes for reasons that have nothing to do with the login.
  const noncanonical = {
    "compact.json": '{"schema_version":1,"login":"someone","starts":1,' +
      '"interval_seconds":60,"last_start_at":"2026-08-07T00:00:00Z",' +
      '"next_allowed_at":"2026-08-07T00:01:00Z"}\n',
    "duplicate.json": canonical(rateDocument({ login: "someone" }))
      .replace('"starts": 3,', '"starts": 3,\n  "starts": 4,'),
    "bignum.json": canonical(rateDocument({ login: "someone", opaque: 1 }))
      .replace('"opaque": 1', '"opaque": 123456789012345678901234567890'),
    "no-newline.json": canonical(rateDocument({ login: "someone" })).trimEnd(),
  };
  const { root, directory } = await stateRepository(noncanonical);

  const { code, stderr } = await attempt(tool("strip-rate-logins.js"), [root, "--write"]);
  assert.equal(code, 1, "refusing to rewrite must not look like success");
  assert.match(stderr, /4 left for a human/);
  for (const name of Object.keys(noncanonical)) {
    assert.match(stderr, new RegExp(`${name.replace(".", "\\.")} carries login`));
    assert.equal(
      await readFile(join(directory, name), "utf8"),
      noncanonical[name],
      `${name} was rewritten despite not being canonical`,
    );
  }
});

test("strip-rate-logins leaves clean documents alone and is idempotent", async () => {
  const clean = canonical(rateDocument());
  const { root, directory } = await stateRepository({
    "aaa.json": canonical(rateDocument({ login: "someone" })),
    "bbb.json": clean,
  });

  await run(tool("strip-rate-logins.js"), [root, "--write"]);
  const first = await readFile(join(directory, "aaa.json"), "utf8");
  assert.equal(await readFile(join(directory, "bbb.json"), "utf8"), clean, "a clean file moved");

  const second = await run(tool("strip-rate-logins.js"), [root, "--write"]);
  assert.match(second.stdout, /0 of 2 rate documents rewritten/);
  assert.equal(await readFile(join(directory, "aaa.json"), "utf8"), first, "a second pass moved it");
  assert.equal(await readFile(join(directory, "bbb.json"), "utf8"), clean);
});

test("strip-rate-logins refuses a directory it was not given", async () => {
  const { code, stderr } = await attempt(tool("strip-rate-logins.js"), []);
  assert.equal(code, 2);
  assert.match(stderr, /usage:/);
  const missing = await attempt(tool("strip-rate-logins.js"), [join(tmpdir(), "palomar-absent")]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /cannot read/);
});
