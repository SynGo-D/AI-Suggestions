import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeFindings } from "../src/database.ts";
import { suggestionSchema } from "../src/model.ts";
import { readConfig } from "../src/config.ts";
import { Authorizer } from "../src/auth.ts";
import type { Config } from "../src/config.ts";

const row = { finding_id: "f1", file_path: "a.js", line: 3, end_line: null, rule_id: "no-undef",
  severity: "error", message: "Unknown identifier", metadata: { on_changed_line: true } };
test("normalizes upstream database fields and preserves unknown locations", () => {
  assert.equal(normalizeFindings([row])[0].endLine, 3);
  assert.equal(normalizeFindings([{ ...row, line: null }])[0].line, 0);
  assert.equal(normalizeFindings([row])[0].onChangedLine, true);
  assert.deepEqual(normalizeFindings([]), []);
});
test("malformed database rows fail closed", () => {
  for (const invalid of [{}, { ...row, severity: "invalid" }, { ...row, end_line: 1 }, { ...row, line: "3" }]) {
    assert.throws(() => normalizeFindings([invalid]));
  }
});
test("model output requires bounded confidence and known fields", () => {
  const valid = { findingId: "f1", classification: "issue", explanation: "Missing identifier", priority: "high",
    severity: "error", confidence: 0.9, debtImpact: "Correctness", suggestedFix: "Declare it", fixAvailable: true };
  assert.equal(suggestionSchema.parse(valid).confidence, 0.9);
  assert.throws(() => suggestionSchema.parse({ ...valid, confidence: 2 }));
  assert.throws(() => suggestionSchema.parse({ ...valid, shell: "arbitrary command" }));
});
test("missing credentials are reported by name without their values", () => {
  assert.throws(() => readConfig({}), /ANALYSIS_DATABASE_URL/);
  assert.throws(() => readConfig({ ANALYSIS_DATABASE_URL: "<placeholder>" }), /ANALYSIS_DATABASE_URL/);
});
test("unauthorized requests never reach a repository dependency", async () => {
  const auth = new Authorizer({ MAIN_BACKEND_URL: "https://example.invalid" } as Config);
  await assert.rejects(auth.repository("o", "r", 1, ""), /Sign in/);
});
