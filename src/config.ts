const required = ["TECHNICAL_DEBT_DATABASE_URL", "ANALYSIS_DATABASE_URL", "GITHUB_API_URL",
  "GITHUB_APP_ID", "GITHUB_INSTALLATION_ID", "GITHUB_PRIVATE_KEY_PATH", "AI_PROVIDER_API_KEY",
  "AI_PROVIDER_BASE_URL", "AI_PROVIDER_MODEL", "INTERNAL_SERVICE_TOKEN", "MAIN_BACKEND_URL",
  "DEBT_TABLE", "DEBT_REPOSITORY_COLUMN", "DEBT_PR_COLUMN", "DEBT_COMMIT_COLUMN",
  "VALIDATOR_IMAGE"] as const;
export type Config = Record<typeof required[number], string> & { PORT: string; JOB_DIRECTORY: string; HOST: string };
export function readConfig(env: NodeJS.ProcessEnv): Config {
  const missing = required.filter(key => !env[key]?.trim() || env[key]?.includes("<"));
  if (missing.length) throw new Error(`Configure required values: ${missing.join(", ")}`);
  for (const key of ["TECHNICAL_DEBT_DATABASE_URL", "ANALYSIS_DATABASE_URL"]) {
    if (!/^postgres(ql)?:\/\//.test(env[key]!)) throw new Error(`${key} must be a PostgreSQL URL`);
  }
  for (const key of ["GITHUB_API_URL", "AI_PROVIDER_BASE_URL", "MAIN_BACKEND_URL"]) {
    const url = new URL(env[key]!);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname))) {
      throw new Error(`${key} must use HTTPS (HTTP is allowed for localhost)`);
    }
  }
  for (const key of ["DEBT_TABLE", "DEBT_REPOSITORY_COLUMN", "DEBT_PR_COLUMN", "DEBT_COMMIT_COLUMN"]) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(env[key]!)) throw new Error(`${key} must be a simple SQL identifier`);
  }
  if (!/^[\w./:-]+@sha256:[a-f0-9]{64}$/.test(env.VALIDATOR_IMAGE!)) throw new Error("VALIDATOR_IMAGE must be pinned by SHA256 digest");
  if (env.INTERNAL_SERVICE_TOKEN!.length < 32) throw new Error("INTERNAL_SERVICE_TOKEN must contain at least 32 characters");
  return { ...Object.fromEntries(required.map(key => [key, env[key]!])), PORT: env.PORT ?? "8010",
    JOB_DIRECTORY: env.JOB_DIRECTORY ?? "data/jobs",
    // Loopback by default, which is right when the service runs directly on
    // a host beside the reverse proxy. A container has its own loopback, so
    // binding there publishes the port to nothing at all — not even to the
    // other services on the compose network. HOST=0.0.0.0 is how a
    // containerised deployment opts in, and the container is only reachable
    // on a private network, so this widens nothing on its own.
    HOST: env.HOST ?? "127.0.0.1" } as Config;
}
