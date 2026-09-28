import { createSign } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { PullRequestContext } from "./contracts.ts";
import { ServiceError } from "./errors.ts";
import { safePath } from "./patch.ts";

const refSchema = z.object({ ref: z.string(), sha: z.string().regex(/^[a-f0-9]{40}$/),
  repo: z.object({ full_name: z.string(), default_branch: z.string() }) });
const prSchema = z.object({ state: z.string(), head: refSchema, base: refSchema });
const shaSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) });
const createdPrSchema = z.object({ number: z.number().int().positive(), html_url: z.string().url() });

export class GitHub {
  config: Config;
  token = "";
  expires = 0;
  constructor(config: Config) { this.config = config; }
  async installationToken() {
    if (this.expires > Date.now() + 60_000) return this.token;
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 540, iss: this.config.GITHUB_APP_ID })).toString("base64url");
    const signer = createSign("RSA-SHA256").update(`${header}.${payload}`);
    const signature = signer.sign(await readFile(this.config.GITHUB_PRIVATE_KEY_PATH)).toString("base64url");
    const response = await this.request(`/app/installations/${encodeURIComponent(this.config.GITHUB_INSTALLATION_ID)}/access_tokens`,
      "POST", {}, `${header}.${payload}.${signature}`);
    const data = z.object({ token: z.string(), expires_at: z.string() }).parse(response);
    this.token = data.token; this.expires = Date.parse(data.expires_at);
    return this.token;
  }
  async request(path: string, method = "GET", body?: unknown, token?: string): Promise<unknown> {
    const response = await fetch(`${this.config.GITHUB_API_URL.replace(/\/$/, "")}${path}`, {
      method, signal: AbortSignal.timeout(30_000), redirect: "error",
      headers: { Authorization: `Bearer ${token ?? await this.installationToken()}`,
        Accept: "application/vnd.github+json", "Content-Type": "application/json", "X-GitHub-Api-Version": "2022-11-28" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new ServiceError(response.status === 403 || response.status === 404 ? 403 : 502,
      "github_error", "GitHub rejected the request. Check repository access, branch protection and app permissions.");
    return response.status === 204 ? null : response.json();
  }
  path(owner: string, repo: string) { return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`; }
  async pull(owner: string, repo: string, number: number) {
    const pr = prSchema.parse(await this.request(`${this.path(owner, repo)}/pulls/${number}`));
    if (pr.state !== "open") throw new ServiceError(409, "already_fixed", "The original pull request is no longer open.");
    if (pr.head.repo.full_name.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
      throw new ServiceError(422, "fork_not_supported", "Fix creation currently supports same-repository pull requests only.");
    }
    return pr;
  }
  async sources(owner: string, repo: string, sha: string) {
    const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), mode: z.string(),
      type: z.string(), sha: z.string(), size: z.number().optional() })) }).parse(
      await this.request(`${this.path(owner, repo)}/git/trees/${sha}?recursive=1`));
    if (tree.truncated || tree.tree.length > 1500) throw new ServiceError(422, "too_large", "Repository snapshot exceeds the supported size.");
    const files: Record<string, string> = Object.create(null);
    let size = 0;
    for (const entry of tree.tree) {
      if (entry.type !== "blob" || entry.mode !== "100644" || !safePath(entry.path)) continue;
      if ((entry.size ?? 0) > 200_000) continue;
      size += entry.size ?? 0;
      if (size > 5_000_000) throw new ServiceError(422, "too_large", "Repository snapshot exceeds 5 MB.");
      const blob = z.object({ content: z.string(), encoding: z.literal("base64") }).parse(
        await this.request(`${this.path(owner, repo)}/git/blobs/${entry.sha}`));
      const bytes = Buffer.from(blob.content, "base64");
      const content = bytes.toString("utf8");
      if (!content.includes("\0") && Buffer.from(content).equals(bytes)) files[entry.path] = content;
    }
    return files;
  }
  async createFix(context: PullRequestContext, files: Record<string, string>, jobId: string, digest: string) {
    const pr = await this.pull(context.owner, context.repository, context.number);
    if (pr.head.sha !== context.headSha || pr.head.ref !== context.sourceBranch) throw new ServiceError(409, "stale_commit", "The source PR changed. Generate a new fix for its latest commit.");
    const branch = `ai-fixes/${context.number}/${jobId}`;
    if (["main", "master", pr.head.repo.default_branch].includes(context.sourceBranch)) {
      throw new ServiceError(403, "protected_target", "Fix PRs cannot target main, master or the default branch.");
    }
    const path = this.path(context.owner, context.repository);
    // Deterministic branch and PR lookup make retries safe after an uncertain network response.
    const existing = z.array(createdPrSchema).parse(await this.request(`${path}/pulls?state=all&head=${encodeURIComponent(`${context.owner}:${branch}`)}&base=${encodeURIComponent(context.sourceBranch)}`));
    const commit = z.object({ tree: shaSchema }).parse(await this.request(`${path}/git/commits/${context.headSha}`));
    const tree = shaSchema.parse(await this.request(`${path}/git/trees`, "POST", { base_tree: commit.tree.sha,
      tree: Object.entries(files).map(([file, content]) => ({ path: file, mode: "100644", type: "blob", content })) }));
    if (existing[0]) {
      const existingPr = prSchema.parse(await this.request(`${path}/pulls/${existing[0].number}`));
      const existingCommit = z.object({ tree: shaSchema }).parse(await this.request(`${path}/git/commits/${existingPr.head.sha}`));
      if (existingCommit.tree.sha !== tree.sha || existingPr.base.ref !== context.sourceBranch || existingPr.state !== "open") {
        throw new ServiceError(409, "branch_conflict", "The existing fix PR differs from the validated patch or is no longer open.");
      }
      return { branch, sha: existingPr.head.sha, ...existing[0] };
    }
    const fixed = shaSchema.parse(await this.request(`${path}/git/commits`, "POST", {
      message: `Fix selected findings for PR #${context.number}`, tree: tree.sha, parents: [context.headSha],
    }));
    const refs = z.array(z.object({ ref: z.string(), object: shaSchema })).parse(await this.request(`${path}/git/matching-refs/heads/${branch}`));
    const ref = refs.find(r => r.ref === `refs/heads/${branch}`);
    if (ref) {
      const existingCommit = z.object({ tree: shaSchema }).parse(await this.request(`${path}/git/commits/${ref.object.sha}`));
      if (existingCommit.tree.sha !== tree.sha) throw new ServiceError(409, "branch_conflict", "The fix branch contains different changes; it will not be overwritten.");
    } else await this.request(`${path}/git/refs`, "POST", { ref: `refs/heads/${branch}`, sha: fixed.sha });
    const created = createdPrSchema.parse(await this.request(`${path}/pulls`, "POST", {
      title: `AI fixes for PR #${context.number}`, head: branch, base: context.sourceBranch,
      body: `Validated fixes for selected findings in #${context.number}.\n\nSource commit: ${context.headSha}\nPatch SHA256: ${digest}\n\nAwaiting human review. The original branch has not been directly changed.`,
    }));
    return { branch, sha: ref?.object.sha ?? fixed.sha, ...created };
  }
  async mergeFix(context: PullRequestContext, number: number, expectedSha: string, branch: string) {
    const path = this.path(context.owner, context.repository);
    const original = await this.pull(context.owner, context.repository, context.number);
    if (original.head.sha !== context.headSha || original.head.ref !== context.sourceBranch) throw new ServiceError(409, "stale_commit", "The source branch changed; regenerate and validate the fix.");
    const fix = prSchema.parse(await this.request(`${path}/pulls/${number}`));
    if (fix.head.sha !== expectedSha || fix.head.ref !== branch || fix.base.ref !== context.sourceBranch ||
      ["main", "master", original.head.repo.default_branch].includes(fix.base.ref)) {
      throw new ServiceError(409, "merge_conflict", "The fix PR changed or targets a protected branch.");
    }
    const result = z.object({ merged: z.boolean() }).parse(await this.request(`${path}/pulls/${number}/merge`, "PUT",
      { sha: expectedSha, merge_method: "merge" }));
    if (!result.merged) throw new ServiceError(409, "merge_rejected", "GitHub did not merge this PR. Review its checks and branch protection.");
  }
}
