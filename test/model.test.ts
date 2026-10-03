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

function contextWithFindings(): PullRequestContext {
  return {
    owner: "org", repository: "repo", number: 1, sourceBranch: "feature", targetBranch: "main",
    headSha: "a".repeat(40), files: { "a.js": "var value = 1;\n" }, technicalDebt: {}, analysis: {},
    findings: [{ id: "f1", file: "a.js", line: 1, endLine: 1, rule: "no-var",
      severity: "warning", message: "Use const", onChangedLine: true }],
  };
}

test("review rejects missing, duplicate and invented finding IDs", async () => {
  for (const suggestions of [[], ["f1", "f1"], ["invented"]]) {
    const model = { json: async () => ({ suggestions: suggestions.map(findingId => ({
      findingId, classification: "issue", explanation: "Explanation", priority: "medium",
      severity: "warning", confidence: 0.8, debtImpact: "Debt", suggestedFix: "Fix", fixAvailable: true,
    })) }) } as unknown as Model;
    await assert.rejects(new ReviewAgent(model).run(contextWithFindings()), /does not match the requested findings/);
  }
});

test("review removes fix availability from false positives", async () => {
  const model = { json: async () => ({ suggestions: [{
    findingId: "f1", classification: "false_positive", explanation: "Not an issue", priority: "low",
    severity: "info", confidence: 0.8, debtImpact: "None", suggestedFix: "None", fixAvailable: true,
  }] }) } as unknown as Model;
  const suggestions = await new ReviewAgent(model).run(contextWithFindings());
  assert.equal(suggestions[0].fixAvailable, false);
});

test("fix rejects model edits with unrecognized fields", async () => {
  const model = { json: async () => ({ edits: [{ findingId: "f1", file: "a.js", startLine: 1, endLine: 1,
    expected: "var value = 1;", replacement: "const value = 1;", command: "npm test" }] }) } as unknown as Model;
  await assert.rejects(new FixAgent(model).run(contextWithFindings(), []), /Unexpected edit fields/);
});
