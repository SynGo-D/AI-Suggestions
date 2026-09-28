import { createHash } from "node:crypto";
import type { Edit, Finding } from "./contracts.ts";

export function safePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 &&
    !/[\\\s\x00-\x1f:\x7f]/.test(path) && !path.startsWith("/") &&
    path.split("/").every(part => part !== "" && part !== "." && part !== ".." &&
      ![".git", ".github", ".env"].includes(part.toLowerCase()) &&
      !part.toLowerCase().startsWith(".env."));
}

export function patchDigest(patch: string): string {
  return createHash("sha256").update(patch).digest("hex");
}

/** Reject untrusted model output before using any paths or edit coordinates. */
export function parseEdits(raw: unknown): Edit[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 100) {
    throw new Error("Expected between 1 and 100 edits");
  }
  return raw.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid edit");
    const edit = value as Record<string, unknown>;
    const keys = ["findingId", "file", "startLine", "endLine", "expected", "replacement"];
    if (Object.keys(edit).some(key => !keys.includes(key)) ||
      !keys.every(key => Object.hasOwn(edit, key))) throw new Error("Unexpected edit fields");
    for (const key of ["findingId", "file", "expected", "replacement"]) {
      if (typeof edit[key] !== "string") throw new Error(`Invalid ${key}`);
    }
    if (!Number.isSafeInteger(edit.startLine) || !Number.isSafeInteger(edit.endLine) ||
      Number(edit.startLine) < 1 || Number(edit.endLine) < Number(edit.startLine)) {
      throw new Error("Invalid edit line range");
    }
    if (!safePath(String(edit.file)) || String(edit.replacement).length > 100_000 ||
      String(edit.expected).length > 100_000 || String(edit.replacement).includes("\0")) {
      throw new Error("Unsafe edit");
    }
    return edit as unknown as Edit;
  });
}

/** Limit every replacement to the exact finding range at the collected commit. */
export function applyEdits(
  sources: Record<string, string>, findings: Finding[], selectedIds: string[], raw: unknown,
): { files: Record<string, string>; patch: string; digest: string } {
  if (!selectedIds.length || new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("Select distinct findings");
  }
  const selected = new Map(findings.filter(f => selectedIds.includes(f.id)).map(f => [f.id, f]));
  if (selected.size !== selectedIds.length) throw new Error("Unknown selected finding");
  const edits = parseEdits(raw);
  const grouped = new Map<string, Edit[]>();
  for (const edit of edits) {
    const finding = selected.get(edit.findingId);
    if (!finding || edit.file !== finding.file || edit.startLine < finding.line ||
      edit.endLine > finding.endLine || !Object.hasOwn(sources, edit.file)) {
      throw new Error("Edit is outside selected finding scope");
    }
    const group = grouped.get(edit.file) ?? [];
    group.push(edit);
    grouped.set(edit.file, group);
  }
  if (selectedIds.some(id => !edits.some(edit => edit.findingId === id))) {
    throw new Error("Generated patch omits selected findings");
  }
  const files: Record<string, string> = Object.create(null);
  const diff: string[] = [];
  for (const [file, group] of grouped) {
    const source = sources[file];
    if (source.includes("\0") || source.includes("\r")) {
      throw new Error("Only UTF-8 text with LF line endings is currently supported");
    }
    const lines = source.split("\n");
    const hasFinalNewline = source.endsWith("\n");
    if (hasFinalNewline) lines.pop();
    group.sort((a, b) => a.startLine - b.startLine);
    let previousEnd = 0;
    let offset = 0;
    const updated = [...lines];
    diff.push(`--- a/${file}`, `+++ b/${file}`);
    for (const edit of group) {
      if (edit.startLine <= previousEnd || edit.endLine > lines.length) throw new Error("Overlapping or invalid edits");
      previousEnd = edit.endLine;
      const old = lines.slice(edit.startLine - 1, edit.endLine);
      if (old.join("\n") !== edit.expected) throw new Error("Source changed: expected text does not match");
      if (edit.expected === edit.replacement) throw new Error("Edit makes no change");
      if (edit.replacement.includes("\r")) throw new Error("Replacement must use LF line endings");
      const replacement = edit.replacement === "" ? [] : edit.replacement.split("\n");
      const newStart = edit.startLine + offset;
      diff.push(`@@ -${edit.startLine},${old.length} +${replacement.length ? newStart : newStart - 1},${replacement.length} @@`);
      diff.push(...old.map(line => `-${line}`));
      if (!hasFinalNewline && edit.endLine === lines.length) diff.push("\\ No newline at end of file");
      diff.push(...replacement.map(line => `+${line}`));
      if (!hasFinalNewline && edit.endLine === lines.length && replacement.length) diff.push("\\ No newline at end of file");
      updated.splice(edit.startLine - 1 + offset, old.length, ...replacement);
      offset += replacement.length - old.length;
    }
    const deletedLastLine = group.at(-1)!.endLine === lines.length && group.at(-1)!.replacement === "";
    files[file] = updated.join("\n") + ((hasFinalNewline || deletedLastLine) && updated.length ? "\n" : "");
  }
  const patch = diff.join("\n") + "\n";
  return { files, patch, digest: patchDigest(patch) };
}
