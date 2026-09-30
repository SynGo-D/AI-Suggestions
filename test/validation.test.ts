import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PatchValidator } from "../src/validation.ts";
const actual = promisify(execFile);
const patch = "--- a/a.js\n+++ b/a.js\n@@ -1,1 +1,1 @@\n-var a = 1;\n+const a = 1;\n";
for (const state of ["passed", "failed", "unavailable", "malformed"] as const) {
  test(`validation gate handles ${state} sandbox report`, async () => {
    const calls: string[][] = [];
    const execute = (async (command: string, args: string[], options: object) => {
      if (command === "git") return actual(command, args, options);
      calls.push(args);
      if (args[0] === "run") {
        const mount = args.find(arg => arg.endsWith("target=/output"))!;
        const output = mount.slice("type=bind,source=".length, -",target=/output".length);
        const report = state === "malformed" ? {} : { checks: [
          { name: "syntax", status: "passed", details: "parsed" },
          { name: "lint", status: state, details: "lint result" },
          { name: "tests", status: "passed", details: "test result" },
        ] };
        await writeFile(join(output, "result.json"), JSON.stringify(report));
      }
      return { stdout: "", stderr: "" };
    }) as typeof actual;
    const validator = new PatchValidator("example@sha256:" + "a".repeat(64), execute);
    const result = await validator.run({ "a.js": "const a = 1;\n" }, { "a.js": "var a = 1;\n" }, patch, "a".repeat(40));
    assert.equal(result.status, state === "passed" ? "passed" : "failed");
    assert.ok(calls[0].includes("--network=none")); assert.ok(calls[0].includes("--read-only"));
    assert.equal(calls.at(-1)?.[0], "rm");
  });
}
test("unavailable Docker fails validation and retains patch check details", async () => {
  const execute = (async (command: string, args: string[], options: object) => {
    if (command === "git") return actual(command, args, options);
    throw new Error("Docker is unavailable");
  }) as typeof actual;
  const result = await new PatchValidator("image", execute).run({ "a.js": "const a = 1;\n" }, { "a.js": "var a = 1;\n" }, patch, "a".repeat(40));
  assert.equal(result.status, "failed"); assert.equal(result.checks[0].status, "passed");
});
