import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { readConfig } from "./config.ts";
import { Databases } from "./database.ts";
import { GitHub } from "./github.ts";
import { Authorizer } from "./auth.ts";
import { ContextLoader, DeliveryAgent } from "./agents.ts";
import { Model, ReviewAgent, FixAgent } from "./model.ts";
import { PatchValidator } from "./validation.ts";
import { Jobs } from "./jobs.ts";
import { ServiceError, publicError } from "./errors.ts";

const createSchema = z.object({ owner: z.string().regex(/^[a-zA-Z0-9-]{1,100}$/),
  repository: z.string().regex(/^[a-zA-Z0-9_.-]{1,100}$/).refine(s => s !== "." && s !== ".."),
  pullRequestNumber: z.number().int().positive(), headSha: z.string().regex(/^[a-f0-9]{40}$/),
  selectedFindingIds: z.array(z.string().min(1).max(200)).max(100),
}).strict();
async function main() {
  const config = readConfig(process.env);
  const db = new Databases(config); await db.check();
  const github = new GitHub(config); const model = new Model(config); const auth = new Authorizer(config);
  const jobs = new Jobs(config.JOB_DIRECTORY, {
    loader: new ContextLoader(db, github),
    review: new ReviewAgent(model),
    fix: new FixAgent(model),
    delivery: new DeliveryAgent(github, new PatchValidator(config.VALIDATOR_IMAGE)),
  });
  await jobs.init();
  const lockPath = join(config.JOB_DIRECTORY, "worker.lock");
  const lock = await open(lockPath, "wx");
  await lock.writeFile(String(process.pid));
  const server = createServer(async (req, res) => {
    res.setHeader("Content-Type", "application/json"); res.setHeader("Cache-Control", "no-store");
    try {
      if (req.url === "/health" && req.method === "GET") { res.end(JSON.stringify({ status: "ok" })); return; }
      const supplied = Buffer.from(String(req.headers["x-internal-token"] ?? ""));
      const expected = Buffer.from(config.INTERNAL_SERVICE_TOKEN);
      if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new ServiceError(401, "unauthorized", "Unauthorized service request.");
      const bearer = req.headers.authorization ?? "";
      let body: unknown = {};
      if (req.method === "POST") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 32_000) throw new ServiceError(413, "too_large", "Request is too large.");
        }
        try { body = JSON.parse(raw || "{}"); } catch { throw new ServiceError(400, "invalid_request", "Invalid JSON request."); }
      }
      if (req.url === "/jobs" && req.method === "POST") {
        const data = createSchema.parse(body);
        await auth.repository(data.owner, data.repository, data.pullRequestNumber, bearer);
        const result = await jobs.create(data.owner, data.repository, data.pullRequestNumber, data.headSha, data.selectedFindingIds);
        res.statusCode = result.duplicate ? 200 : 202; res.end(JSON.stringify(result)); return;
      }
      const match = req.url?.match(/^\/jobs\/([a-f0-9]{64})(?:\/(validate|publish|retry|merge))?$/);
      if (!match) throw new ServiceError(404, "not_found", "Endpoint not found.");
      const record = jobs.get(match[1]); const j = record.job;
      await auth.repository(j.owner, j.repository, j.pullRequestNumber, bearer);
      if (req.method === "GET" && !match[2]) { res.end(JSON.stringify({ job: j })); return; }
      if (req.method !== "POST" || !match[2]) throw new ServiceError(405, "method_not_allowed", "Method not allowed.");
      if (match[2] === "merge") {
        const confirmation = z.object({ confirm: z.literal(true), commitSha: z.string() }).strict().parse(body);
        await auth.merge(j.owner, j.repository, bearer);
        if (jobs.busy.has(j.id)) throw new ServiceError(409, "duplicate_request", "This job is already processing.");
        if (j.status === "merged") { res.end(JSON.stringify({ job: j })); return; }
        if (j.status !== "pull_request_created" || !record.context || !j.createdPullRequestNumber || !j.commitSha ||
          !j.fixBranch || confirmation.commitSha !== j.commitSha) throw new ServiceError(409, "invalid_state", "Confirm the current validated fix PR before merging.");
        jobs.busy.add(j.id);
        try {
          await github.mergeFix(record.context, j.createdPullRequestNumber, j.commitSha, j.fixBranch);
          j.status = "merged"; await jobs.save(record);
        } finally { jobs.busy.delete(j.id); }
        res.end(JSON.stringify({ job: j })); return;
      }
      res.statusCode = 202;
      res.end(JSON.stringify({ job: jobs.action(j.id, match[2] as "validate" | "publish" | "retry") }));
    } catch (error) {
      const safe = error instanceof z.ZodError ? new ServiceError(400, "invalid_request", "Request data is missing or malformed.") : publicError(error);
      res.statusCode = safe.status; res.end(JSON.stringify({ error: { code: safe.code, message: safe.message } }));
    }
  });
  server.requestTimeout = 60_000;
  server.listen(Number(config.PORT), "127.0.0.1", () => console.log(`AI-Suggestions listening on port ${config.PORT}`));
  const stop = () => server.close(() => { void (async () => {
    await db.close(); await lock.close(); await unlink(lockPath); process.exit(0);
  })(); });
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
main().catch(error => { console.error(error instanceof Error && error.message.startsWith("Configure required") ? error.message :
  "Startup failed. Check required configuration, database connections, and the single-worker lock."); process.exitCode = 1; });
