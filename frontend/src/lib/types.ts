// Mirrors the backend agent's event + result shapes (backend/src/agent/runAgent.ts).

export type Severity = "high" | "medium" | "low";

export interface Finding {
  severity: Severity;
  category?: string;
  title: string;
  description: string;
  fix: string;
  url?: string;
  screenshot?: string;
}

export interface Screenshot {
  id: string;
  base64: string;
}

export interface AuditResult {
  url: string;
  status: "done" | "blocked" | "max_steps" | "cancelled";
  steps: number;
  findings: Finding[];
  summary: string;
  screenshots: Screenshot[];
}

export interface Step {
  index: number;
  tool: string;
  args: Record<string, unknown>;
  result: unknown;
}

export type RunStatus =
  | "idle"
  | "starting"
  | "running"
  | "done"
  | "error"
  | "cancelled";
