import { z } from "zod";
import type { Config } from "./config.ts";
import { ServiceError } from "./errors.ts";

/**
 * What a role may do, as main-backend's requireCapability states it and
 * the user manual publishes it. This service asks main-backend rather
 * than deciding for itself: the roles live in integration-service's
 * tables, and a second copy of that lookup here is a second thing to get
 * wrong. The names match main-backend's capabilities exactly so a
 * mismatch is a 403 to debug rather than a silent grant.
 */
const accessSchema = z.object({
  roles: z.array(z.string()),
  capabilities: z.record(z.string(), z.boolean()),
});

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
  /** The capabilities the caller holds on this repository. */
  async capabilities(owner: string, repo: string, bearer: string): Promise<Record<string, boolean>> {
    const access = accessSchema.parse(
      await this.request(`/api/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/access`, bearer));
    return access.capabilities;
  }
  /**
   * Requesting a fix and publishing it belong to developers and
   * administrators. A manager runs the project; they do not put code in
   * it, and this service writes a branch and a pull request.
   */
  async fix(owner: string, repo: string, bearer: string) {
    const capabilities = await this.capabilities(owner, repo, bearer);
    if (!capabilities.debtAndFixes) {
      throw new ServiceError(403, "unauthorized", "Requesting and publishing AI fixes is for developers and administrators.");
    }
  }
  /** Confirming the merge, same two roles, checked at the moment it matters. */
  async merge(owner: string, repo: string, bearer: string) {
    const capabilities = await this.capabilities(owner, repo, bearer);
    if (!capabilities.mergeFix) {
      throw new ServiceError(403, "unauthorized", "Confirming a fix merge is for developers and administrators.");
    }
  }
}
