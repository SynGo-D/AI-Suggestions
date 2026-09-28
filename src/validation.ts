import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";
import type { ValidationResult } from "./contracts.ts";
import { safePath, patchDigest } from "./patch.ts";
const run = promisify(execFile);
const reportSchema = z.object({ checks: z.array(z.object({ name: z.enum(["lint", "tests", "syntax"]),
  status: z.enum(["passed", "failed", "unavailable"]), details: z.string().max(12000) }).strict()).length(3) }).strict();

/** Executes only an administrator-selected immutable image, with no service secrets or network. */
export class ValidationAgent {
  image: string;
  execute: typeof run;
  constructor(image: string, execute: typeof run = run) { this.image = image; this.execute = execute; }
  async run(files: Record<string, string>, originals: Record<string, string>, patch: string, headSha: string): Promise<ValidationResult> {
    const root = await mkdtemp(join(tmpdir(), "ai-fix-validation-"));
    const workspace = join(root, "workspace");
    const output = join(root, "output");
    const checks: ValidationResult["checks"] = [];
    try {
      await mkdir(workspace); await mkdir(output);
      for (const [file, content] of Object.entries(originals)) {
        if (!safePath(file)) throw new Error("Unsafe source path");
        await mkdir(dirname(join(workspace, file)), { recursive: true });
        await writeFile(join(workspace, file), content);
      }
      await writeFile(join(root, "fix.patch"), patch);
      await this.execute("git", ["-c", "core.autocrlf=false", "apply", "--check", "--unidiff-zero", join(root, "fix.patch")], { cwd: workspace, timeout: 15_000 });
      await this.execute("git", ["-c", "core.autocrlf=false", "apply", "--unidiff-zero", join(root, "fix.patch")], { cwd: workspace, timeout: 15_000 });
      for (const [file, content] of Object.entries(files)) {
        if (await readFile(join(workspace, file), "utf8") !== content) throw new Error("Patch application differs from preview");
      }
      checks.push({ name: "patch", status: "passed", details: "Patch applies exactly to the collected source." });
      const name = `ai-validator-${root.split(/[\\/]/).pop()!.toLowerCase()}`;
      try {
        await this.execute("docker", ["run", "--rm", "--name", name, "--network=none", "--read-only", "--cap-drop=ALL",
          "--security-opt=no-new-privileges", "--pids-limit=128", "--memory=512m", "--cpus=1",
          "--tmpfs", "/tmp:rw,noexec,nosuid,size=128m", "--mount", `type=bind,source=${workspace},target=/workspace,readonly`,
          "--mount", `type=bind,source=${output},target=/output`, this.image], { timeout: 180_000, maxBuffer: 100_000 });
      } finally {
        await this.execute("docker", ["rm", "-f", name], { timeout: 10_000 }).catch(() => undefined);
      }
      const report = reportSchema.parse(JSON.parse(await readFile(join(output, "result.json"), "utf8")));
      if (new Set(report.checks.map(c => c.name)).size !== 3) throw new Error("Missing required validation checks");
      checks.push(...report.checks);
    } catch {
      checks.push({ name: "validation", status: "failed", details: "Patch application or sandbox validation failed. Verify Git, Docker and the configured validator image." });
    } finally { await rm(root, { recursive: true, force: true }); }
    return { status: checks.length === 4 && checks.every(c => c.status === "passed") ? "passed" : "failed",
      patchDigest: patchDigest(patch), headSha, checks };
  }
}
