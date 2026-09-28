export interface Finding {
  id: string;
  file: string;
  line: number;
  endLine: number;
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  onChangedLine: boolean;
}

export interface Suggestion {
  findingId: string;
  classification: "issue" | "false_positive" | "low_priority";
  explanation: string;
  priority: "high" | "medium" | "low";
  severity: Finding["severity"];
  confidence: number;
  debtImpact: string;
  suggestedFix: string;
  fixAvailable: boolean;
}

/** Exact, line-bounded replacements; the service generates the diff itself. */
export interface Edit {
  findingId: string;
  file: string;
  startLine: number;
  endLine: number;
  expected: string;
  replacement: string;
}

export interface PullRequestContext {
  owner: string;
  repository: string;
  number: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  files: Record<string, string>;
  findings: Finding[];
  technicalDebt: Record<string, unknown>;
  analysis: Record<string, unknown>;
}

export interface ValidationResult {
  status: "passed" | "failed";
  patchDigest: string;
  headSha: string;
  checks: { name: string; status: "passed" | "failed" | "unavailable"; details: string }[];
}

export type JobStatus = "queued" | "collecting" | "generating_suggestion" |
  "patch_ready" | "validating" | "validation_succeeded" | "validation_failed" |
  "creating_pull_request" | "pull_request_created" | "merged" | "already_fixed" | "failed";

export interface FixJob {
  id: string;
  owner: string;
  repository: string;
  pullRequestNumber: number;
  sourceBranch: string;
  targetBranch: string;
  headSha: string;
  selectedFindingIds: string[];
  status: JobStatus;
  findings: Finding[];
  suggestions: Suggestion[];
  patch: string | null;
  changedFiles: string[];
  validation: ValidationResult | null;
  error: { code: string; message: string } | null;
  fixBranch: string | null;
  commitSha: string | null;
  pullRequestUrl: string | null;
  createdPullRequestNumber: number | null;
  createdAt: string;
  updatedAt: string;
}
