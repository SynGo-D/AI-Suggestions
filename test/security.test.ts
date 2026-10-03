import { test } from "node:test";
import assert from "node:assert/strict";
import { Authorizer } from "../src/auth.ts";
import { readConfig, type Config } from "../src/config.ts";

const validEnvironment = {
  ANALYSIS_DATABASE_URL: "postgresql://localhost/shared",
  GITHUB_API_URL: "https://api.github.com",
  GITHUB_APP_ID: "app",
  GITHUB_INSTALLATION_ID: "installation",
  GITHUB_PRIVATE_KEY_PATH: "private-key.pem",
  AI_PROVIDER_API_KEY: "key",
  AI_PROVIDER_BASE_URL: "https://provider.example",
  AI_PROVIDER_MODEL: "model",
  INTERNAL_SERVICE_TOKEN: "a".repeat(32),
  MAIN_BACKEND_URL: "http://localhost:5000",
  DEBT_TABLE: "debt_records",
  DEBT_REPOSITORY_COLUMN: "repository",
  DEBT_PR_COLUMN: "pr",
  DEBT_COMMIT_COLUMN: "sha",
  VALIDATOR_IMAGE: `validator@sha256:${"a".repeat(64)}`,
};

test("configuration rejects non-PostgreSQL and insecure remote URLs", () => {
  assert.throws(() => readConfig({ ...validEnvironment, ANALYSIS_DATABASE_URL: "mysql://localhost/db" }), /PostgreSQL/);
  assert.throws(() => readConfig({ ...validEnvironment, AI_PROVIDER_BASE_URL: "http://provider.example" }), /HTTPS/);
});

test("configuration rejects unsafe SQL identifiers", () => {
  assert.throws(() => readConfig({ ...validEnvironment, DEBT_TABLE: "debt; DROP TABLE findings" }), /SQL identifier/);
});

test("configuration requires an immutable validator image", () => {
  assert.throws(() => readConfig({ ...validEnvironment, VALIDATOR_IMAGE: "validator:latest" }), /pinned by SHA256/);
});

test("configuration rejects short internal service tokens", () => {
  assert.throws(() => readConfig({ ...validEnvironment, INTERNAL_SERVICE_TOKEN: "short" }), /at least 32/);
});

test("repository authorization URL-encodes untrusted path segments", async () => {
  const authorizer = new Authorizer({ MAIN_BACKEND_URL: "https://backend.example" } as Config);
  let requested = "";
  authorizer.request = async (path) => { requested = path; return {}; };
  await authorizer.repository("owner name", "repo/name", 7, "Bearer token");
  assert.equal(requested, "/api/repositories/owner%20name/repo%2Fname/analysis/pull-requests/7");
});

test("merge authorization accepts a manager for an active matching repository", async () => {
  const authorizer = new Authorizer({ MAIN_BACKEND_URL: "https://backend.example" } as Config);
  authorizer.request = async (path) => path === "/api/organizations"
    ? [{ role: "MANAGER", organization: { id: "org-1" } }]
    : [{ repositoryOwner: "ORG", repositoryName: "Repo", status: "ACTIVE" }];
  await authorizer.merge("org", "repo", "Bearer token");
});

test("merge authorization rejects non-manager memberships", async () => {
  const authorizer = new Authorizer({ MAIN_BACKEND_URL: "https://backend.example" } as Config);
  authorizer.request = async () => [{ role: "DEVELOPER", organization: { id: "org-1" } }];
  await assert.rejects(authorizer.merge("org", "repo", "Bearer token"), /manager or administrator/);
});
