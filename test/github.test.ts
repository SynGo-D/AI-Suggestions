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
test("repository snapshots include only safe UTF-8 source files", async () => {
  const { github, calls } = fixture();
  github.request = async (path) => {
    calls.push({ path, method: "GET", body: undefined });
    if (path.includes("git/trees/")) return { truncated: false, tree: [
      { path: "src/a.js", mode: "100644", type: "blob", sha: "1", size: 12 },
      { path: ".github/workflows/release.yml", mode: "100644", type: "blob", sha: "2", size: 12 },
      { path: "assets/large.bin", mode: "100644", type: "blob", sha: "3", size: 200_001 },
      { path: "link.js", mode: "120000", type: "blob", sha: "4", size: 8 },
      { path: "src/binary.dat", mode: "100644", type: "blob", sha: "5", size: 3 },
    ] };
    if (path.endsWith("git/blobs/1")) return { content: Buffer.from("const a = 1;\n").toString("base64"), encoding: "base64" };
    if (path.endsWith("git/blobs/5")) return { content: Buffer.from([0, 1, 2]).toString("base64"), encoding: "base64" };
    throw new Error(`Unexpected path ${path}`);
  };
  const files = await github.sources("org", "repo", sha);
  assert.deepEqual({ ...files }, { "src/a.js": "const a = 1;\n" });
  assert.equal(calls.filter(call => call.path.includes("git/blobs/")).length, 2);
});
test("truncated repository snapshots are rejected before blob downloads", async () => {
  const { github, calls } = fixture();
  github.request = async (path) => {
    calls.push({ path, method: "GET", body: undefined });
    return { truncated: true, tree: [] };
  };
  await assert.rejects(github.sources("org", "repo", sha), /supported size/);
  assert.equal(calls.length, 1);
});
test("repository snapshots with more than 1,500 entries are rejected", async () => {
  const { github, calls } = fixture();
  github.request = async (path) => {
    calls.push({ path, method: "GET", body: undefined });
    return { truncated: false, tree: Array.from({ length: 1_501 }, (_, index) => ({
      path: `src/file-${index}.js`, mode: "100644", type: "blob", sha: String(index), size: 1,
    })) };
  };
  await assert.rejects(github.sources("org", "repo", sha), /supported size/);
  assert.equal(calls.length, 1);
});
