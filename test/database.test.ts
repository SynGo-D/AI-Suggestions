import { test } from "node:test";
import assert from "node:assert/strict";
import { Databases } from "../src/database.ts";
import type { Config } from "../src/config.ts";

function fixture(options: {
  missingAnalysis?: boolean;
  missingDebt?: boolean;
  tooManyFindings?: boolean;
  tooManyDebtRecords?: boolean;
} = {}) {
  const databases = new Databases({ ANALYSIS_DATABASE_URL: "postgresql://example.invalid/analysis",
    DEBT_TABLE: "debt_records", DEBT_REPOSITORY_COLUMN: "repository", DEBT_PR_COLUMN: "pr",
    DEBT_COMMIT_COLUMN: "sha" } as Config);
  const queries: { text: string; values: unknown[] }[] = [];
  let released = false;
  databases.database.connect = (async () => ({
    query: async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      if (text.includes("FROM analysis_results")) return { rows: options.missingAnalysis ? [] : [{ result_id: "result-1", metrics: {} }] };
      if (text.includes("FROM findings")) return { rows: options.tooManyFindings
        ? Array.from({ length: 5_001 }, (_, index) => ({ finding_id: `f${index}`, file_path: "a.js", line: 1,
          end_line: 1, rule_id: "no-var", severity: "warning", message: "Use const", metadata: {} }))
        : [{ finding_id: "f1", file_path: "a.js", line: 1,
          end_line: 1, rule_id: "no-var", severity: "warning", message: "Use const", metadata: {} }] };
      if (text.includes('FROM "debt_records"')) return { rows: options.missingDebt ? []
        : options.tooManyDebtRecords ? Array.from({ length: 1_001 }, () => ({ score: 5 })) : [{ score: 5 }] };
      return { rows: [] };
    }, release: () => { released = true; },
  })) as unknown as typeof databases.database.connect;
  return { databases, queries, released: () => released };
}
test("loads analysis and debt from one database in a read-only transaction", async () => {
  const { databases, queries, released } = fixture();
  try {
    const data = await databases.load("org/repo", 7, "a".repeat(40));
    assert.equal(data.findings[0].id, "f1"); assert.deepEqual(data.technicalDebt.records, [{ score: 5 }]);
    assert.match(queries[0].text, /READ ONLY/);
    assert.deepEqual(queries.find(q => q.text.includes("FROM analysis_results"))?.values, ["org/repo", 7, "a".repeat(40)]);
    assert.deepEqual(queries.find(q => q.text.includes('FROM "debt_records"'))?.values, ["org/repo", 7, "a".repeat(40)]);
    assert.ok(queries.some(q => q.text === "COMMIT"));
    assert.ok(released());
  } finally { await databases.close(); }
});
test("missing analysis rolls back and does not query debt", async () => {
  const { databases, queries, released } = fixture({ missingAnalysis: true });
  try {
    await assert.rejects(databases.load("org/repo", 7, "a".repeat(40)), /No completed analysis/);
    assert.ok(queries.some(q => q.text === "ROLLBACK")); assert.ok(released());
    assert.ok(!queries.some(q => q.text.includes('FROM "debt_records"')));
  } finally { await databases.close(); }
});
test("missing debt records never fabricate technical-debt context", async () => {
  const { databases, queries, released } = fixture({ missingDebt: true });
  try {
    await assert.rejects(databases.load("org/repo", 7, "a".repeat(40)), /No technical-debt record/);
    assert.ok(queries.some(q => q.text === "ROLLBACK")); assert.ok(released());
  }
  finally { await databases.close(); }
});
test("finding limits fail closed and roll back before querying debt", async () => {
  const { databases, queries, released } = fixture({ tooManyFindings: true });
  try {
    await assert.rejects(databases.load("org/repo", 7, "a".repeat(40)), /finding limit/);
    assert.ok(queries.some(q => q.text === "ROLLBACK")); assert.ok(released());
    assert.ok(!queries.some(q => q.text.includes('FROM "debt_records"')));
  } finally { await databases.close(); }
});
test("technical-debt limits fail closed and roll back", async () => {
  const { databases, queries, released } = fixture({ tooManyDebtRecords: true });
  try {
    await assert.rejects(databases.load("org/repo", 7, "a".repeat(40)), /row limit/);
    assert.ok(queries.some(q => q.text === "ROLLBACK")); assert.ok(released());
  } finally { await databases.close(); }
});
