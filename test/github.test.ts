import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHub } from "../src/github.ts";
import type { Config } from "../src/config.ts";
import type { PullRequestContext } from "../src/contracts.ts";
const sha = "a".repeat(40), treeSha = "b".repeat(40), fixedSha = "c".repeat(40);
const context: PullRequestContext = { owner: "org", repository: "repo", number: 1,
  sourceBranch: "feature", targetBranch: "main", headSha: sha, files: {}, findings: [], technicalDebt: {}, analysis: {} };
function fixture(stale = false) {
  const github = new GitHub({} as Config);
  const calls: { path: string; method: string; body: unknown }[] = [];
  github.request = async (path, method = "GET", body) => {
    calls.push({ path, method, body });
    if (path.endsWith("/pulls/1")) return { state: "open", head: { sha: stale ? fixedSha : sha, ref: "feature", repo: { full_name: "org/repo", default_branch: "main" } },
      base: { sha, ref: "main", repo: { full_name: "org/repo", default_branch: "main" } } };
    if (path.includes("pulls?")) return [];
    if (path.includes("git/commits/") && method === "GET") return { tree: { sha: treeSha } };
    if (path.endsWith("git/trees")) return { sha: treeSha };
    if (path.endsWith("git/commits")) return { sha: fixedSha };
    if (path.includes("matching-refs")) return [];
    if (path.endsWith("git/refs")) return {};
    if (path.endsWith("pulls")) return { number: 2, html_url: "https://github.com/org/repo/pull/2" };
    throw new Error(`Unexpected path ${path}`);
  };
  return { github, calls };
}
test("GitHub creates a separate branch and PR without updating or merging the original", async () => {
  const { github, calls } = fixture();
  const result = await github.createFix(context, { "a.js": "fixed" }, "job", "digest");
  assert.equal(result.sha, fixedSha);
  assert.deepEqual(calls.find(c => c.path.endsWith("git/refs"))?.body, { ref: "refs/heads/ai-fixes/1/job", sha: fixedSha });
  assert.equal((calls.find(c => c.path.endsWith("/pulls"))?.body as { base: string }).base, "feature");
  assert.ok(!calls.some(c => c.method === "PATCH" || c.method === "PUT"));
});
test("stale source fails before GitHub mutations", async () => {
  const { github, calls } = fixture(true);
  await assert.rejects(github.createFix(context, { "a.js": "fixed" }, "job", "digest"), /source PR changed/);
  assert.ok(calls.every(c => c.method === "GET"));
});
test("protected fix targets are refused", async () => {
  const { github, calls } = fixture();
  const request = github.request.bind(github);
  github.request = async (path, method, body) => {
    const value = await request(path, method, body);
    if (path.endsWith("/pulls/1")) (value as { head: { ref: string } }).head.ref = "main";
    return value;
  };
  await assert.rejects(github.createFix({ ...context, sourceBranch: "main" }, {}, "job", "digest"), /cannot target/);
  assert.ok(calls.every(c => c.method === "GET"));
});
