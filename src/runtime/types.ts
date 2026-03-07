export type CliArgs = Record<string, string | boolean>;

export type FileConfig = {
  defaults?: {
    waitMs?: number;
    pollIntervalMs?: number;
    modelSearchLimit?: number;
    artifactDownloadLimit?: number;
    objectTtlSeconds?: number;
    downloadOutputs?: boolean;
  };
  workspace?: {
    rootDir?: string;
    autoCleanupHours?: number;
  };
  misc?: {
    setupWebAutoStopMinutes?: number;
  };
};

export type FalAuthState = {
  apiKey?: string;
  adminApiKey?: string;
  source?: "args" | "env" | "file";
  adminSource?: "args" | "env" | "file";
};

export type FileAuthConfig = {
  fal?: {
    apiKey?: string;
    adminApiKey?: string;
  };
};

export type RuntimeConfig = {
  defaults: {
    waitMs: number;
    pollIntervalMs: number;
    modelSearchLimit: number;
    artifactDownloadLimit: number;
    objectTtlSeconds: number;
    downloadOutputs: boolean;
  };
  workspace: {
    rootDir: string;
    autoCleanupHours: number;
  };
  misc: {
    setupWebAutoStopMinutes: number;
  };
};

export type SavedModelSummary = {
  endpointId: string;
  displayName?: string;
  category?: string;
  status?: string;
  provider?: string;
};

export type SavedModelSearchSession = {
  savedAt: string;
  query?: string;
  category?: string;
  status?: string;
  limit: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  items: SavedModelSummary[];
};

export type SavedRequestHistoryItem = {
  requestId: string;
  endpointId: string;
  sentAt?: string;
  endedAt?: string;
  statusCode?: number;
  duration?: number;
};

export type SavedRequestHistorySession = {
  savedAt: string;
  endpointId: string;
  limit: number;
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  expandPayloads: boolean;
  items: SavedRequestHistoryItem[];
};

export type SavedUsageItem = {
  endpointId?: string;
  startDate?: string;
  endDate?: string;
  authMethod?: string;
  granularity?: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  cost?: number;
  currency?: string;
};

export type SavedUsageSession = {
  savedAt: string;
  endpointIds?: string[];
  startDate?: string;
  endDate?: string;
  granularity?: "minute" | "hour" | "day";
  cursor?: string;
  nextCursor?: string;
  hasMore: boolean;
  mode: "summary" | "time_series" | "both";
  items: SavedUsageItem[];
  summary?: SavedUsageItem | null;
};

export type ArtifactRecord = {
  pointer: string;
  sourceKind: "remote" | "inline_data";
  sourceUrl?: string;
  localPath: string;
  contentType?: string;
  size?: number;
};

export type ArtifactIssue = {
  pointer: string;
  sourceKind: "remote" | "inline_data";
  sourceUrl?: string;
  severity: "warning" | "error";
  message: string;
};

export type RunRecord = {
  runId: string;
  workspaceId: string;
  endpointId: string;
  requestId?: string;
  mode: "queue" | "sync";
  createdAt: string;
  updatedAt: string;
  status: string;
  inputPath: string;
  statusPath?: string;
  responsePath?: string;
  artifactsDir?: string;
  artifacts: ArtifactRecord[];
  artifactIssues?: ArtifactIssue[];
  cost?: {
    updatedAt: string;
    price?: {
      unitPrice?: number;
      unit?: string;
      currency?: string;
    };
    estimate?: {
      totalCost?: number;
      currency?: string;
      estimateType?: string;
      quantity?: number;
    };
    usage?: {
      cost?: number;
      currency?: string;
      quantity?: number;
      unit?: string;
      unitPrice?: number;
      startDate?: string;
      endDate?: string;
      confidence?: "usage_window" | "usage_summary" | "estimated" | "unknown";
    };
  };
  error?: string;
};

export type WorkspaceIndexEntry = {
  workspaceId: string;
  label?: string;
  createdAt: string;
  updatedAt: string;
  path: string;
  runCount: number;
  lastRunId?: string;
};

export type PersistedState = {
  models?: {
    lastSession?: SavedModelSearchSession;
  };
  requests?: {
    lastHistory?: SavedRequestHistorySession;
  };
  costs?: {
    lastUsage?: SavedUsageSession;
  };
  workspaces?: {
    items: WorkspaceIndexEntry[];
    lastWorkspaceId?: string;
    lastRunId?: string;
  };
};

export type RuntimeState = {
  args: CliArgs;
  runtime: RuntimeConfig;
  auth: FalAuthState;
  state: PersistedState;
  configPath: string;
  authPath: string;
  statePath: string;
  configArgProvided: boolean;
  authArgProvided: boolean;
  stateArgProvided: boolean;
};
