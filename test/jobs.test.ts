import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Jobs } from "../src/jobs.ts";
import type { Agents } from "../src/jobs.ts";
import type { PullRequestContext } from "../src/contracts.ts";
import { patchDigest } from "../src/patch.ts";

const sha = "a".repeat(40);
const context: PullRequestContext = { owner: "org", repository: "repo", number: 1, headSha: sha,
  sourceBranch: "feature", targetBranch: "development", files: { "a.js": "var a = 1;\n" },
  findings: [{ id: "f1", file: "a.js", line: 1, endLine: 1, rule: "no-var", severity: "warning", message: "Use const", onChangedLine: true }],
  technicalDebt: { score: 1 }, analysis: { status: "completed" } };
async function settle(jobs: Jobs) {
  for (let count = 0; jobs.busy.size && count < 1000; count++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(jobs.busy.size, 0);
}
async function fixture(run: (jobs: Jobs, calls: string[]) => Promise<void>, failValidation = false) {
  const directory = await mkdtemp(join(tmpdir(), "ai-jobs-test-")); const calls: string[] = [];
  const agents = {
    collect: { run: async () => { calls.push("collect"); return context; } },
    analyze: { run: async () => { calls.push("analyze"); return {}; } },
    debt: { run: async () => { calls.push("debt"); return {}; } },
    suggest: { run: async () => { calls.push("suggest"); return [{ findingId: "f1", fixAvailable: true }]; } },
    fix: { run: async () => { calls.push("fix"); return [{ findingId: "f1", file: "a.js", startLine: 1, endLine: 1, expected: "var a = 1;", replacement: "const a = 1;" }]; } },
    validate: { run: async (_files: unknown, _originals: unknown, patch: string, headSha: string) => {
      calls.push("validate"); return { status: failValidation ? "failed" : "passed", checks: [], patchDigest: patchDigest(patch), headSha };
    } },
    pr: { run: async () => { calls.push("pr"); return { branch: "ai-fixes/1/id", sha, number: 2, html_url: "https://example.invalid/pr/2" }; } },
  } as unknown as Agents;
  const jobs = new Jobs(directory, agents); await jobs.init();
  try { await run(jobs, calls); } finally { await settle(jobs); await rm(directory, { recursive: true, force: true }); }
}
test("agents run in order, duplicate clicks share a job, validation gates PR creation", async () => {
  await fixture(async (jobs, calls) => {
    const first = await jobs.create("org", "repo", 1, sha, ["f1"]);
    const duplicate = await jobs.create("org", "repo", 1, sha, ["f1"]);
    assert.equal(duplicate.duplicate, true); assert.equal(first.job.id, duplicate.job.id);
    await settle(jobs);
    assert.deepEqual(calls, ["collect", "analyze", "debt", "suggest", "fix"]);
    assert.throws(() => jobs.action(first.job.id, "publish"), /must pass validation/);
    jobs.action(first.job.id, "validate"); await settle(jobs);
    assert.equal(first.job.status, "validation_succeeded");
    jobs.action(first.job.id, "publish"); await settle(jobs);
    assert.equal(first.job.status, "pull_request_created");
    jobs.action(first.job.id, "publish"); assert.equal(calls.filter(c => c === "pr").length, 1);
    const restored = new Jobs(jobs.directory, jobs.agents); await restored.init();
    assert.equal(restored.get(first.job.id).job.pullRequestUrl, first.job.pullRequestUrl);
  });
});
test("failed lint/test validation prevents publication", async () => {
  await fixture(async (jobs, calls) => {
    const { job } = await jobs.create("org", "repo", 1, sha, ["f1"]); await settle(jobs);
    jobs.action(job.id, "validate"); await settle(jobs);
    assert.equal(job.status, "validation_failed");
    assert.throws(() => jobs.action(job.id, "publish")); assert.ok(!calls.includes("pr"));
  }, true);
});
test("stale commits and unknown finding IDs fail without generating edits", async () => {
  await fixture(async (jobs, calls) => {
    const { job } = await jobs.create("org", "repo", 1, "b".repeat(40), ["f1"]); await settle(jobs);
    assert.equal(job.error?.code, "stale_commit");
    const other = await jobs.create("org", "repo", 1, sha, ["unknown"]); await settle(jobs);
    assert.equal(other.job.error?.code, "unknown_finding"); assert.ok(!calls.includes("fix"));
  });
});
test("suggestion-only jobs never create a patch or PR", async () => {
  await fixture(async (jobs, calls) => {
    const { job } = await jobs.create("org", "repo", 1, sha, []); await settle(jobs);
    assert.equal(job.patch, null); assert.ok(job.suggestions.length); assert.ok(!calls.includes("fix"));
  });
});
