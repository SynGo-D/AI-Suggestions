import { test } from "node:test";
import assert from "node:assert/strict";
import { Authorizer } from "../src/auth.ts";
import type { Config } from "../src/config.ts";

/*
The roles table, enforced at the two points where this service writes to
somebody's repository: creating or publishing a fix, and confirming its
merge. Both belong to developers and administrators. A manager runs the
project and does not put code in it, which is the distinction the ladder
of seniority cannot express and why main-backend answers in capabilities
rather than in a role this service would have to rank for itself.
*/
const config = { MAIN_BACKEND_URL: "https://api.example.invalid" } as Config;
const BEARER = "Bearer token";

function respondWith(capabilities: Record<string, boolean>) {
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ roles: ["x"], capabilities }), {
      status: 200, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return calls;
}

test("a developer or administrator may request a fix and confirm its merge", async () => {
  respondWith({ view: true, rules: true, debtAndFixes: true, mergeFix: true });
  const auth = new Authorizer(config);

  await auth.fix("acme", "shop", BEARER);
  await auth.merge("acme", "shop", BEARER);
});

test("a manager may not request a fix", async () => {
  respondWith({ view: true, rules: false, debtAndFixes: false, mergeFix: false });
  const auth = new Authorizer(config);

  await assert.rejects(auth.fix("acme", "shop", BEARER), /developers and administrators/);
});

test("a manager may not confirm a merge", async () => {
  respondWith({ view: true, rules: false, debtAndFixes: false, mergeFix: false });
  const auth = new Authorizer(config);

  await assert.rejects(auth.merge("acme", "shop", BEARER), /developers and administrators/);
});

test("the capability is asked of main-backend for the repository in hand", async () => {
  const calls = respondWith({ debtAndFixes: true, mergeFix: true });
  const auth = new Authorizer(config);

  await auth.fix("acme", "shop", BEARER);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "https://api.example.invalid/api/repositories/acme/shop/access");
});

test("a missing bearer is refused before anything is asked", async () => {
  const calls = respondWith({ debtAndFixes: true });
  const auth = new Authorizer(config);

  await assert.rejects(auth.fix("acme", "shop", ""), /Sign in/);
  assert.equal(calls.length, 0);
});
