import type { Databases } from "./database.ts";
import type { GitHub } from "./github.ts";
import type { PullRequestContext } from "./contracts.ts";
import type { PatchValidator } from "./validation.ts";

/** Deterministic input adapter. Data collection does not need a model agent. */
export class ContextLoader {
  databases: Databases;
  github: GitHub;
  constructor(databases: Databases, github: GitHub) { this.databases = databases; this.github = github; }
  async run(owner: string, repository: string, number: number): Promise<PullRequestContext> {
    const pr = await this.github.pull(owner, repository, number);
    const [data, files] = await Promise.all([
      this.databases.load(`${owner}/${repository}`, number, pr.head.sha),
      this.github.sources(owner, repository, pr.head.sha),
    ]);
    return { owner, repository, number, sourceBranch: pr.head.ref, targetBranch: pr.base.ref, headSha: pr.head.sha, files, ...data };
  }
}
/**
 * The third workflow agent. It owns the deterministic safety gate and delivery
 * actions, while GitHub and Docker remain ordinary adapters beneath it.
 */
export class DeliveryAgent {
  github: GitHub;
  validator: PatchValidator;
  constructor(github: GitHub, validator: PatchValidator) { this.github = github; this.validator = validator; }
  validate(files: Record<string, string>, originals: Record<string, string>, patch: string, headSha: string) {
    return this.validator.run(files, originals, patch, headSha);
  }
  publish(context: PullRequestContext, files: Record<string, string>, id: string, digest: string) {
    return this.github.createFix(context, files, id, digest);
  }
}
