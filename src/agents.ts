import type { Databases } from "./database.ts";
import type { GitHub } from "./github.ts";
import type { PullRequestContext } from "./contracts.ts";
export class DataCollectionAgent {
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
export class PullRequestAgent {
  github: GitHub;
  constructor(github: GitHub) { this.github = github; }
  run(context: PullRequestContext, files: Record<string, string>, id: string, digest: string) {
    return this.github.createFix(context, files, id, digest);
  }
}
