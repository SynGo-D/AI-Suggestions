import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { applyEdits } from "../src/patch.ts";
import type { Finding } from "../src/contracts.ts";
const run = promisify(execFile);

for (const [source, start, replacement] of [
  ["one\ntwo\nthree\n", 2, "second\nextra"], ["one\ntwo", 2, "last"],
  ["one\ntwo", 2, ""], ["one\n", 1, ""], ["one\ntwo\n", 1, ""],
] as const) {
  test(`Git applies exact preview: ${JSON.stringify([source, start, replacement])}`, async () => {
    const root = await mkdtemp(join(tmpdir(), "ai-patch-test-"));
    const finding: Finding = { id: "f", file: "a.js", line: start, endLine: start, rule: "r", severity: "warning", message: "m", onChangedLine: true };
    const result = applyEdits({ "a.js": source }, [finding], ["f"], [{ findingId: "f", file: "a.js", startLine: start,
      endLine: start, expected: source.split("\n")[start - 1], replacement }]);
    try {
      await writeFile(join(root, "a.js"), source); await writeFile(join(root, "fix.patch"), result.patch);
      await run("git", ["-c", "core.autocrlf=false", "apply", "--unidiff-zero", "fix.patch"], { cwd: root });
      assert.equal(await readFile(join(root, "a.js"), "utf8"), result.files["a.js"]);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
