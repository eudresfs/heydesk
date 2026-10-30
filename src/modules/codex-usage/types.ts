export interface UsageDay {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  responseCount: number;
  sessionCount: number;
  cacheWriteInputTokens: number | null;
}

export interface CodexUsageSnapshot {
  enabled: boolean;
  status: "disabled" | "loading" | "ready" | "empty" | "not_installed" | "insufficient_data" | "error";
  lastUpdated: string | null;
  scanning: boolean;
  scannedFiles: number;
  pendingFiles: number;
  legacyOnlyFiles: number;
  invalidRecords: number;
  conflicts: number;
  today: UsageDay | null;
  days: UsageDay[];
  error: string | null;
}
