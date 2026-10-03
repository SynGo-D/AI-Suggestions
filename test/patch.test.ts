import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEdits, parseEdits, safePath } from "../src/patch.ts";
import type { Finding } from "../src/contracts.ts";

const findings: Finding[] = [1, 2].map(line => ({
  id: `f${line}`, file: "src/file.ts", line, endLine: line,
  rule: "no-var", severity: "warning", message: "Use const", onChangedLine: true,
}));
const sources = { "src/file.ts": "var a = 1;\nvar b = 2;\nkeep();\n" };
const edit = (line: number) => ({ findingId: `f${line}`, file: "src/file.ts",
  startLine: line, endLine: line, expected: `var ${line === 1 ? "a" : "b"} = ${line};`,
  replacement: `const ${line === 1 ? "a" : "b"} = ${line};` });

test("one finding preserves unrelated source", () => {
  const result = applyEdits(sources, findings, ["f1"], [edit(1)]);
  assert.equal(result.files["src/file.ts"], "const a = 1;\nvar b = 2;\nkeep();\n");
  assert.match(result.patch, /@@ -1,1 \+1,1 @@/);
  assert.equal(result.digest.length, 64);
});
test("multiple findings combine into one patch", () => {
  const result = applyEdits(sources, findings, ["f1", "f2"], [edit(2), edit(1)]);
  assert.equal(result.files["src/file.ts"], "const a = 1;\nconst b = 2;\nkeep();\n");
});
test("rejects stale source and changes outside selection", () => {
  assert.throws(() => applyEdits(sources, findings, ["f1"], [{ ...edit(1), expected: "stale" }]));
  assert.throws(() => applyEdits(sources, findings, ["f1"], [edit(2)]));
  assert.throws(() => applyEdits(sources, findings, ["f1", "f2"], [edit(1)]));
  assert.throws(() => applyEdits(sources, findings, ["f1"], [edit(1), edit(1)]));
});
test("rejects traversal, configuration changes and malformed model output", () => {
  for (const path of ["../a", "/a", "C:/a", "a\\b", ".git/config", ".github/workflows/a", ".env.local", "a\nb"]) {
    assert.equal(safePath(path), false, path);
  }
  for (const raw of [null, [], ["diff"], [{ ...edit(1), command: "run" }], [{ ...edit(1), startLine: 1.5 }]]) {
    assert.throws(() => parseEdits(raw));
  }
});
test("multiline replacements update offsets without changing surrounding code", () => {
  const source = { "src/file.ts": "start();\noldA();\noldB();\nend();\n" };
  const scoped: Finding[] = [{ id: "multi", file: "src/file.ts", line: 2, endLine: 3,
    rule: "rewrite", severity: "warning", message: "Rewrite", onChangedLine: true }];
  const result = applyEdits(source, scoped, ["multi"], [{ findingId: "multi", file: "src/file.ts",
    startLine: 2, endLine: 3, expected: "oldA();\noldB();", replacement: "newA();\nnewB();\nnewC();" }]);
  assert.equal(result.files["src/file.ts"], "start();\nnewA();\nnewB();\nnewC();\nend();\n");
  assert.match(result.patch, /@@ -2,2 \+2,3 @@/);
});
test("edit parsing enforces the 100-edit resource limit", () => {
  assert.throws(() => parseEdits(Array.from({ length: 101 }, () => edit(1))), /between 1 and 100 edits/);
});
