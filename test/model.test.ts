import { test } from "node:test";
import assert from "node:assert/strict";
import { FixAgent, ReviewAgent, type Model } from "../src/model.ts";
import type { PullRequestContext } from "../src/contracts.ts";

test("one review call and one fix call replace the former four-call chain", async () => {
  const calls: { task: string; input: unknown }[] = [];
  const model = {
    json: async (task: string, input: unknown) => {
      calls.push({ task, input });
      if (calls.length === 1) return { suggestions: [{
        findingId: "f1", classification: "issue", explanation: "Use a constant",
        priority: "medium", severity: "warning", confidence: 0.95,
        debtImpact: "Reduces maintainability warnings", suggestedFix: "Replace var with const",
        fixAvailable: true,
      }] };
      return { edits: [{ findingId: "f1", file: "a.js", startLine: 1, endLine: 1,
        expected: "var value = 1;", replacement: "const value = 1;" }] };
    },
  } as unknown as Model;
  const context: PullRequestContext = {
    owner: "org", repository: "repo", number: 1, sourceBranch: "feature", targetBranch: "development",
    headSha: "a".repeat(40), files: { "a.js": "var value = 1;\n" },
    findings: [{ id: "f1", file: "a.js", line: 1, endLine: 1, rule: "no-var",
      severity: "warning", message: "Use const", onChangedLine: true }],
    technicalDebt: { maintainability: 2 }, analysis: { complexity: 1 },
  };

  const suggestions = await new ReviewAgent(model).run(context);
  const edits = await new FixAgent(model).run(context, suggestions);

  assert.equal(calls.length, 2);
  assert.equal(suggestions[0].debtImpact, "Reduces maintainability warnings");
  assert.equal(edits[0].replacement, "const value = 1;");
  assert.match(calls[0].task, /technical-debt/);
});
