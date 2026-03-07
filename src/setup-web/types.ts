import type { FalAuthState, PersistedState, RuntimeConfig } from "../runtime.js";

export type SetupWebConfigPatch = {
  fal?: {
    apiKey?: string | null;
    adminApiKey?: string | null;
  };
  defaults?: Partial<RuntimeConfig["defaults"]>;
  workspace?: Partial<RuntimeConfig["workspace"]>;
  misc?: Partial<RuntimeConfig["misc"]>;
};

export type SetupWebState = {
  host: string;
  port: number;
  url: string;
  token: string;
};

export type SetupWebOptions = {
  host: string;
  port: number;
  token?: string;
  configPath: string;
  authPath: string;
  statePath: string;
};

export type SetupWebHandlers = {
  getRuntime: () => RuntimeConfig;
  getAuth: () => FalAuthState;
  getPersistedState: () => PersistedState;
  reloadState?: () => Promise<void>;
  saveConfigPatch: (patch: SetupWebConfigPatch) => Promise<RuntimeConfig>;
  clearAuth: () => Promise<FalAuthState>;
};

export type SetupWebController = {
  state: SetupWebState;
  close: () => Promise<void>;
};
