import { performance } from "node:perf_hooks";
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFindings } from "../src/database.ts";
import { applyEdits } from "../src/patch.ts";
import type { Edit, Finding } from "../src/contracts.ts";

test("normalizes the maximum 5,000 findings within a regression budget", () => {
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    finding_id: `f${index}`, file_path: `src/file-${index % 10}.ts`, line: index + 1, end_line: index + 1,
    rule_id: "rule", severity: "warning", message: "Message", metadata: { on_changed_line: index % 2 === 0 },
  }));
  const started = performance.now();
  const findings = normalizeFindings(rows);
  const elapsed = performance.now() - started;

  assert.equal(findings.length, 5_000);
  assert.equal(findings[4_999].id, "f4999");
  assert.ok(elapsed < 2_000, `normalization took ${elapsed.toFixed(1)}ms`);
});

test("applies the maximum 100 model edits within a regression budget", () => {
  const lines = Array.from({ length: 1_000 }, (_, index) => `const value${index} = ${index};`);
  const sources = { "src/large.ts": `${lines.join("\n")}\n` };
  const findings: Finding[] = [];
  const edits: Edit[] = [];
  const selectedIds: string[] = [];
  for (let index = 0; index < 100; index += 1) {
    const line = index * 10 + 1;
    const findingId = `f${index}`;
    selectedIds.push(findingId);
    findings.push({ id: findingId, file: "src/large.ts", line, endLine: line,
      rule: "prefer-let", severity: "warning", message: "Change declaration", onChangedLine: true });
    edits.push({ findingId, file: "src/large.ts", startLine: line, endLine: line,
      expected: lines[line - 1], replacement: lines[line - 1].replace("const", "let") });
  }
  const started = performance.now();
  const result = applyEdits(sources, findings, selectedIds, edits);
  const elapsed = performance.now() - started;

  assert.equal((result.patch.match(/^@@/gm) ?? []).length, 100);
  assert.equal(result.digest.length, 64);
  assert.ok(elapsed < 2_000, `patch generation took ${elapsed.toFixed(1)}ms`);
});
