import pg from "pg";
import { z } from "zod";
import type { Config } from "./config.ts";
import type { Finding } from "./contracts.ts";
import { ServiceError } from "./errors.ts";

const rowSchema = z.object({ finding_id: z.string(), file_path: z.string(),
  line: z.number().int().positive().nullable(), end_line: z.number().int().positive().nullable(),
  rule_id: z.string(), severity: z.enum(["error", "warning", "info"]), message: z.string(),
  metadata: z.record(z.unknown()).nullable() });
export function normalizeFindings(rows: unknown[]): Finding[] {
  return rows.map(row => {
    const value = rowSchema.parse(row);
    if (value.line && value.end_line && value.end_line < value.line) throw new Error("Invalid finding range");
    return { id: value.finding_id, file: value.file_path, line: value.line ?? 0,
      endLine: value.end_line ?? value.line ?? 0, rule: value.rule_id, severity: value.severity,
      message: value.message, onChangedLine: value.metadata?.on_changed_line === true };
  });
}

export class Databases {
  database: pg.Pool;
  config: Config;
  constructor(config: Config) {
    this.config = config;
    const options = { max: 4, connectionTimeoutMillis: 10_000, statement_timeout: 15_000,
      options: "-c default_transaction_read_only=on" };
    this.database = new pg.Pool({ ...options, connectionString: config.ANALYSIS_DATABASE_URL });
    // Pool errors must not crash the process or log connection secrets.
    this.database.on("error", () => console.error("Database connection error"));
  }
  async check() { await this.database.query("SELECT 1"); }
  async load(repository: string, number: number, sha: string) {
    const conn = await this.database.connect();
    let analysis: Record<string, unknown>;
    let findings: Finding[];
    let technicalDebt: Record<string, unknown>[];
    try {
      await conn.query("BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const result = await conn.query(`SELECT * FROM analysis_results WHERE repository=$1
        AND pull_request_number=$2 AND commit_sha=$3 AND status='completed' ORDER BY created_at DESC LIMIT 1`, [repository, number, sha]);
      if (!result.rows[0]) throw new ServiceError(409, "analysis_not_ready", "No completed analysis exists for the current PR commit.");
      analysis = result.rows[0];
      const rows = await conn.query("SELECT * FROM findings WHERE result_id=$1 ORDER BY file_path,line LIMIT 5001", [analysis.result_id]);
      if (rows.rows.length > 5000) throw new ServiceError(422, "too_large", "Analysis exceeds the finding limit.");
      findings = normalizeFindings(rows.rows);
      const c = this.config;
      // Identifiers are operator configuration, validated at startup; values are bound parameters.
      const debt = await conn.query(`SELECT * FROM "${c.DEBT_TABLE}" WHERE "${c.DEBT_REPOSITORY_COLUMN}"=$1
        AND "${c.DEBT_PR_COLUMN}"=$2 AND "${c.DEBT_COMMIT_COLUMN}"=$3 LIMIT 1001`, [repository, number, sha]);
      if (!debt.rows.length) throw new ServiceError(409, "debt_not_ready", "No technical-debt record exists for the current PR commit.");
      if (debt.rows.length > 1000) throw new ServiceError(422, "too_large", "Technical-debt context exceeds the row limit.");
      technicalDebt = debt.rows;
      await conn.query("COMMIT");
    } catch (error) { await conn.query("ROLLBACK"); throw error; } finally { conn.release(); }
    return { analysis, findings, technicalDebt: { records: technicalDebt } };
  }
  async close() { await this.database.end(); }
}
