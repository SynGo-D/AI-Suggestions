import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import type { FixJob, PullRequestContext } from "./contracts.ts";
import type { ContextLoader, DeliveryAgent } from "./agents.ts";
import type { ReviewAgent, FixAgent } from "./model.ts";
import { applyEdits, patchDigest } from "./patch.ts";
import { ServiceError, publicError } from "./errors.ts";

interface StoredJob { job: FixJob; context?: PullRequestContext; files?: Record<string, string> }
export interface WorkflowDependencies {
  loader: ContextLoader;
  review: ReviewAgent;
  fix: FixAgent;
  delivery: DeliveryAgent;
}
export class Jobs {
  directory: string;
  workflow: WorkflowDependencies;
  records = new Map<string, StoredJob>();
  busy = new Set<string>();
  constructor(directory: string, workflow: WorkflowDependencies) { this.directory = directory; this.workflow = workflow; }
  async init() {
    await mkdir(this.directory, { recursive: true });
    for (const file of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) continue;
      const record = JSON.parse(await readFile(join(this.directory, file), "utf8")) as StoredJob;
      if (["queued", "collecting", "generating_suggestion", "validating", "creating_pull_request"].includes(record.job.status)) {
        record.job.status = record.job.patch ? "patch_ready" : "failed";
        record.job.error = { code: "interrupted", message: "Service restarted during processing. Retry the job or validate its saved patch." };
      }
      this.records.set(record.job.id, record);
    }
  }
  get(id: string) {
    const record = this.records.get(id);
    if (!record) throw new ServiceError(404, "not_found", "Fix job not found.");
    return record;
  }
  async save(record: StoredJob) {
    record.job.updatedAt = new Date().toISOString();
    const target = join(this.directory, `${record.job.id}.json`);
    await writeFile(`${target}.tmp`, JSON.stringify(record), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  }
  async create(owner: string, repository: string, number: number, sha: string, selectedIds: string[]) {
    const ids = [...new Set(selectedIds)].sort();
    const id = createHash("sha256").update(JSON.stringify([owner.toLowerCase(), repository.toLowerCase(), number, sha, ids])).digest("hex");
    const existing = this.records.get(id);
    if (existing) return { job: existing.job, duplicate: true };
    if (this.busy.size >= 4) throw new ServiceError(429, "busy", "The service is busy. Please retry shortly.");
    const now = new Date().toISOString();
    const record: StoredJob = { job: { id, owner, repository, pullRequestNumber: number, sourceBranch: "", targetBranch: "", headSha: sha,
      selectedFindingIds: ids, status: "queued", findings: [], suggestions: [], patch: null, changedFiles: [], validation: null,
      error: null, fixBranch: null, commitSha: null, pullRequestUrl: null, createdPullRequestNumber: null, createdAt: now, updatedAt: now } };
    this.records.set(id, record);
    try { await this.save(record); } catch (error) { this.records.delete(id); throw error; }
    this.launch(record, () => this.generate(record));
    return { job: record.job, duplicate: false };
  }
  launch(record: StoredJob, work: () => Promise<void>) {
    if (this.busy.has(record.job.id)) throw new ServiceError(409, "duplicate_request", "This job is already processing.");
    this.busy.add(record.job.id);
    void work().catch(error => {
      const safe = publicError(error);
      record.job.status = safe.code === "already_fixed" ? "already_fixed" : "failed";
      record.job.error = { code: safe.code, message: safe.message };
    }).finally(async () => {
      try { await this.save(record); } catch { console.error("Unable to persist fix job"); }
      this.busy.delete(record.job.id);
    });
  }
  async generate(record: StoredJob) {
    const j = record.job;
    j.status = "collecting";
    const context = await this.workflow.loader.run(j.owner, j.repository, j.pullRequestNumber);
    if (context.headSha !== j.headSha) throw new ServiceError(409, "stale_commit", "The PR commit changed. Refresh the analysis before generating fixes.");
    record.context = context;
    j.sourceBranch = context.sourceBranch; j.targetBranch = context.sourceBranch;
    j.findings = context.findings;
    const selected = j.selectedFindingIds.length ? context.findings.filter(f => j.selectedFindingIds.includes(f.id)) : context.findings;
    if (j.selectedFindingIds.length && selected.length !== j.selectedFindingIds.length) throw new ServiceError(400, "unknown_finding", "A selected finding is missing from the current analysis.");
    if (!selected.length) { j.status = "already_fixed"; return; }
    const relevantFiles = Object.fromEntries([...new Set(selected.map(f => f.file))].filter(f => Object.hasOwn(context.files, f)).map(f => [f, context.files[f]]));
    const limited = { ...context, files: relevantFiles, findings: selected };
    j.status = "generating_suggestion";
    j.suggestions = await this.workflow.review.run(limited);
    if (!j.selectedFindingIds.length) { j.status = "patch_ready"; return; }
    if (j.suggestions.some(s => !s.fixAvailable)) throw new ServiceError(422, "fix_unavailable", "A selected finding cannot be safely fixed within its reported line range.");
    const edits = await this.workflow.fix.run(limited, j.suggestions);
    let result;
    try { result = applyEdits(context.files, context.findings, j.selectedFindingIds, edits); }
    catch { throw new ServiceError(422, "invalid_patch", "The generated patch failed scope or source checks. No source was changed."); }
    record.files = result.files; j.patch = result.patch; j.changedFiles = Object.keys(result.files); j.status = "patch_ready";
  }
  action(id: string, action: "retry" | "validate" | "publish") {
    const record = this.get(id); const j = record.job;
    if (this.busy.has(id)) throw new ServiceError(409, "duplicate_request", "This job is already processing.");
    if (action === "retry") {
      if (j.status !== "failed" || j.patch) throw new ServiceError(409, "invalid_state", "This job cannot be regenerated.");
      j.error = null; this.launch(record, () => this.generate(record)); return j;
    }
    if (!record.context || !record.files || !j.patch) throw new ServiceError(409, "invalid_state", "Generate a patch first.");
    if (j.status === "pull_request_created" || j.status === "merged") return j;
    if (action === "validate") {
      j.status = "validating"; j.error = null;
      this.launch(record, async () => {
        j.validation = await this.workflow.delivery.validate(record.files!, record.context!.files, j.patch!, j.headSha);
        j.status = j.validation.status === "passed" ? "validation_succeeded" : "validation_failed";
      });
    } else {
      if (j.validation?.status !== "passed" || j.validation.headSha !== j.headSha || j.validation.patchDigest !== patchDigest(j.patch)) {
        throw new ServiceError(409, "validation_required", "This exact patch must pass validation before creating a PR.");
      }
      j.status = "creating_pull_request"; j.error = null;
      this.launch(record, async () => {
        const result = await this.workflow.delivery.publish(record.context!, record.files!, j.id, j.validation!.patchDigest);
        j.fixBranch = result.branch; j.commitSha = result.sha ?? null; j.createdPullRequestNumber = result.number;
        j.pullRequestUrl = result.html_url; j.status = "pull_request_created";
      });
    }
    return j;
  }
}
