import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextLoader, DeliveryAgent } from "../src/agents.ts";
import type { Databases } from "../src/database.ts";
import type { GitHub } from "../src/github.ts";
import type { PatchValidator } from "../src/validation.ts";

test("context loading combines PR, analysis and source data", async () => {
  const sha = "a".repeat(40);
  const github = {
    pull: async () => ({ head: { sha, ref: "feature" }, base: { ref: "main" } }),
    sources: async () => ({ "a.js": "const a = 1;\n" }),
  } as unknown as GitHub;
  const databases = { load: async () => ({
    analysis: { status: "completed" }, findings: [], technicalDebt: { records: [{ score: 1 }] },
  }) } as unknown as Databases;

  const context = await new ContextLoader(databases, github).run("org", "repo", 7);

  assert.equal(context.headSha, sha);
  assert.equal(context.sourceBranch, "feature");
  assert.equal(context.targetBranch, "main");
  assert.equal(context.files["a.js"], "const a = 1;\n");
});

test("delivery agent delegates validation and publication without modifying inputs", async () => {
  const calls: string[] = [];
  const validator = { run: async () => { calls.push("validate"); return { status: "passed" }; } } as unknown as PatchValidator;
  const github = { createFix: async () => { calls.push("publish"); return { number: 2 }; } } as unknown as GitHub;
  const agent = new DeliveryAgent(github, validator);
  const context = { owner: "org", repository: "repo", number: 1 } as never;

  await agent.validate({ "a.js": "new" }, { "a.js": "old" }, "patch", "a".repeat(40));
  await agent.publish(context, { "a.js": "new" }, "job", "digest");

  assert.deepEqual(calls, ["validate", "publish"]);
});
