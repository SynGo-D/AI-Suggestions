import { z } from "zod";
import type { Config } from "./config.ts";
import { ServiceError } from "./errors.ts";
export class Authorizer {
  config: Config;
  constructor(config: Config) { this.config = config; }
  async request(path: string, bearer: string) {
    if (!/^Bearer \S+$/.test(bearer)) throw new ServiceError(401, "unauthorized", "Sign in to use AI Code Fixing.");
    const response = await fetch(`${this.config.MAIN_BACKEND_URL.replace(/\/$/, "")}${path}`, {
      headers: { Authorization: bearer }, signal: AbortSignal.timeout(15_000), redirect: "error",
    });
    if (!response.ok) throw new ServiceError(response.status === 401 ? 401 : 403, "unauthorized", "You do not have access to this repository.");
    return response.json();
  }
  async repository(owner: string, repo: string, number: number, bearer: string) {
    await this.request(`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/analysis/pull-requests/${number}`, bearer);
  }
  async merge(owner: string, repo: string, bearer: string) {
    const memberships = z.array(z.object({ role: z.string(), organization: z.object({ id: z.string() }) })).parse(await this.request("/api/organizations", bearer));
    for (const membership of memberships.filter(m => ["ADMIN", "MANAGER"].includes(m.role))) {
      const integrations = z.array(z.object({ repositoryOwner: z.string(), repositoryName: z.string(), status: z.string() })).parse(
        await this.request(`/api/integrations?organizationId=${encodeURIComponent(membership.organization.id)}`, bearer));
      if (integrations.some(i => i.status === "ACTIVE" && i.repositoryOwner.toLowerCase() === owner.toLowerCase() && i.repositoryName.toLowerCase() === repo.toLowerCase())) return;
    }
    throw new ServiceError(403, "unauthorized", "A project manager or administrator must approve merging this fix.");
  }
}
