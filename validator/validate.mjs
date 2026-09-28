// Trusted image entrypoint, never supplied by a model or the checked repository.
import { cpSync, readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ESLint } from "eslint";
import ts from "typescript";

cpSync("/workspace", "/tmp/project", { recursive: true });
process.chdir("/tmp/project");
const checks = [];
let pkg = {};
try { pkg = JSON.parse(readFileSync("package.json", "utf8")); } catch { /* handled as unavailable below */ }
const files = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (["node_modules", ".git"].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (/\.(?:[cm]?js|jsx|tsx?)$/.test(path)) files.push(path);
  }
}
walk(".");
const syntaxErrors = [];
for (const file of files) {
  const source = readFileSync(file, "utf8");
  const output = ts.transpileModule(source, { fileName: file, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.ESNext } });
  for (const diagnostic of output.diagnostics ?? []) {
    if (diagnostic.category === ts.DiagnosticCategory.Error) syntaxErrors.push(`${file}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`);
  }
}
function command(name, executable, args) {
  const result = spawnSync(executable, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 100_000 });
  return { name, status: result.status === 0 ? "passed" : "failed", details: (result.stdout + result.stderr).slice(-10000) || "Command completed." };
}
checks.push({ name: "syntax", status: !files.length ? "unavailable" : syntaxErrors.length ? "failed" : "passed",
  details: !files.length ? "No supported JavaScript/TypeScript source files." : syntaxErrors.join("\n").slice(0, 10000) || `${files.length} source files parsed.` });
if (existsSync("tsconfig.json") && !syntaxErrors.length) checks[0] = command("syntax", "tsc", ["--noEmit", "--incremental", "false"]);
if (pkg.scripts?.lint) checks.push(command("lint", "npm", ["run", "lint"]));
else {
  const javascript = files.filter(file => /\.[cm]?js$/.test(file));
  try {
    const eslint = new ESLint({ overrideConfigFile: true, overrideConfig: [{ files: ["**/*.{js,mjs,cjs}"],
      rules: { "no-undef": "error", "no-unreachable": "error", "no-dupe-keys": "error" } }] });
    const results = await eslint.lintFiles(javascript);
    checks.push({ name: "lint", status: !javascript.length ? "unavailable" : results.some(r => r.errorCount > 0) ? "failed" : "passed",
      details: results.flatMap(r => r.messages.map(m => `${r.filePath}:${m.line} ${m.message}`)).join("\n").slice(0, 10000) || "Built-in JavaScript checks completed." });
  } catch { checks.push({ name: "lint", status: "failed", details: "Linter could not run." }); }
}
checks.push(pkg.scripts?.test ? command("tests", "npm", ["test"]) :
  { name: "tests", status: "unavailable", details: "No test script is configured. Supply a project-specific validation image." });
writeFileSync("/output/result.json", JSON.stringify({ checks }));
