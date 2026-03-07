import { basename, dirname } from "node:path";

import {
  getFalAdminApiKey,
  getFalAdminApiKeySource,
  getFalApiKey,
  getFalApiKeySource,
  getFalCapabilities,
  getMissingConfigFields
} from "../runtime/capabilities.js";
import type { FalAuthState, PersistedState, RuntimeConfig } from "../runtime.js";

function escapeHtml(value: string | undefined): string {
  return (value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function toScriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

function compactDirPath(value: string): string {
  const dir = dirname(value);
  const home = process.env.HOME;
  if (home && dir.startsWith(home)) {
    return `~${dir.slice(home.length)}`;
  }
  return dir;
}

function sanitizeRuntime(runtime: RuntimeConfig): Record<string, unknown> {
  return {
    defaults: runtime.defaults,
    workspace: runtime.workspace,
    misc: runtime.misc
  };
}

function buildInitialStatusPayload(
  configPath: string,
  authPath: string,
  statePath: string,
  runtime: RuntimeConfig,
  auth: FalAuthState,
  persistedState: PersistedState
): Record<string, unknown> {
  const apiKey = getFalApiKey(auth);
  const adminApiKey = getFalAdminApiKey(auth);
  const capabilities = getFalCapabilities(auth);
  const lastModelSearch = persistedState.models?.lastSession;
  const lastRequestHistory = persistedState.requests?.lastHistory;
  const lastUsage = persistedState.costs?.lastUsage;
  return {
    ok: true,
    configPath,
    authPath,
    statePath,
    missingConfig: getMissingConfigFields(auth),
    auth: {
      apiKeyPresent: Boolean(apiKey),
      source: getFalApiKeySource(auth),
      adminApiKeyPresent: Boolean(adminApiKey),
      adminSource: getFalAdminApiKeySource(auth)
    },
    capabilities,
    defaults: runtime.defaults,
    workspace: runtime.workspace,
    misc: runtime.misc,
    state: {
      workspaceCount: persistedState.workspaces?.items.length ?? 0,
      lastWorkspaceId: persistedState.workspaces?.lastWorkspaceId ?? null,
      lastRunId: persistedState.workspaces?.lastRunId ?? null,
      lastModelSearch: lastModelSearch
        ? {
            query: lastModelSearch.query ?? null,
            category: lastModelSearch.category ?? null,
            count: lastModelSearch.items.length,
            hasMore: lastModelSearch.hasMore,
            nextCursor: lastModelSearch.nextCursor ?? null
          }
        : null,
      lastRequestHistory: lastRequestHistory
        ? {
            endpointId: lastRequestHistory.endpointId,
            count: lastRequestHistory.items.length,
            hasMore: lastRequestHistory.hasMore,
            nextCursor: lastRequestHistory.nextCursor ?? null
          }
        : null,
      lastUsage: lastUsage
        ? {
            endpointIds: lastUsage.endpointIds ?? null,
            count: lastUsage.items.length,
            hasMore: lastUsage.hasMore,
            nextCursor: lastUsage.nextCursor ?? null
          }
        : null
    },
    hint: apiKey
      ? (capabilities.usageAvailable
        ? "fal looks ready. Usage-based cost analysis is enabled."
        : "fal looks ready. Add an optional admin key if you want usage-based cost analysis.")
      : "Add the fal API key and save config before running models."
  };
}

export function buildSetupPage(
  configPath: string,
  authPath: string,
  statePath: string,
  setupToken: string,
  runtime: RuntimeConfig,
  auth: FalAuthState,
  persistedState: PersistedState
): string {
  const configFile = basename(configPath);
  const authFile = basename(authPath);
  const stateFile = basename(statePath);
  const configDir = compactDirPath(configPath);
  const authDir = compactDirPath(authPath);
  const stateDir = compactDirPath(statePath);
  const sharedFilesDir = configDir === authDir && authDir === stateDir ? configDir : null;
  const initialRuntimeJson = toScriptJson(sanitizeRuntime(runtime));
  const initialStatusJson = toScriptJson(
    buildInitialStatusPayload(configPath, authPath, statePath, runtime, auth, persistedState)
  );

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Simple fal MCP Setup</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #081017;
        --bg-soft: #0b151d;
        --panel: rgba(11, 19, 27, 0.94);
        --panel-strong: #0f1c26;
        --panel-muted: #13222d;
        --ink: #ebf5f7;
        --muted: #8ea4af;
        --line: #223745;
        --line-strong: #35505e;
        --accent: #44d2c2;
        --accent-soft: rgba(68, 210, 194, 0.14);
        --accent-faint: rgba(68, 210, 194, 0.08);
        --ok: #4ade80;
        --warn: #fbbf24;
        --danger: #fb7185;
        --shadow: 0 22px 60px rgba(0, 0, 0, 0.26);
        --radius-xl: 22px;
        --radius-lg: 18px;
        --radius-md: 14px;
        --radius-sm: 12px;
      }
      * { box-sizing: border-box; }
      [hidden] { display: none !important; }
      html, body {
        margin: 0;
        padding: 0;
      }
      body {
        min-height: 100vh;
        font-family: "Avenir Next", "Segoe UI", "Trebuchet MS", sans-serif;
        background:
          radial-gradient(circle at top left, rgba(68, 210, 194, 0.12), transparent 32%),
          radial-gradient(circle at top right, rgba(59, 130, 246, 0.1), transparent 24%),
          linear-gradient(180deg, var(--bg) 0%, var(--bg-soft) 100%);
        color: var(--ink);
      }
      main {
        width: min(1140px, calc(100% - 28px));
        margin: 20px auto 40px;
      }
      .shell {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 26px;
        box-shadow: var(--shadow);
        overflow: hidden;
      }
      .hero {
        padding: 18px 18px 16px;
        background:
          radial-gradient(circle at top right, rgba(68, 210, 194, 0.14), transparent 32%),
          linear-gradient(135deg, #10202b 0%, #122732 52%, #152d39 100%);
        border-bottom: 1px solid rgba(53, 80, 94, 0.72);
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1.3fr) minmax(320px, 0.9fr);
        gap: 14px 18px;
        align-items: start;
      }
      .hero-kicker {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 10px;
        padding: 6px 10px;
        border-radius: 999px;
        background: rgba(68, 210, 194, 0.1);
        color: #b9fff5;
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      h1 {
        margin: 0 0 8px;
        font-size: 30px;
        line-height: 1.02;
        letter-spacing: -0.03em;
      }
      .lead {
        margin: 0;
        max-width: 640px;
        color: rgba(235, 245, 247, 0.8);
        font-size: 14px;
        line-height: 1.5;
      }
      .hero-badges {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        margin-top: 14px;
      }
      .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 7px 11px;
        border-radius: 999px;
        border: 1px solid rgba(53, 80, 94, 0.78);
        background: rgba(8, 16, 23, 0.38);
        color: #dcebed;
        font-size: 12px;
        font-weight: 600;
      }
      .badge-dot {
        width: 7px;
        height: 7px;
        border-radius: 999px;
        background: var(--muted);
      }
      .badge.ok .badge-dot { background: var(--ok); }
      .badge.warn .badge-dot { background: var(--warn); }
      .badge.subtle .badge-dot { background: #5f7d8f; }
      .hero-side {
        display: grid;
        gap: 10px;
        justify-items: stretch;
      }
      .files-strip {
        padding: 12px;
        border-radius: 18px;
        border: 1px solid rgba(53, 80, 94, 0.78);
        background: rgba(8, 16, 23, 0.42);
        backdrop-filter: blur(8px);
      }
      .files-head {
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 10px;
      }
      .files-title {
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.08em;
        color: #b9fff5;
      }
      .files-dir {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 11px;
        color: var(--muted);
      }
      .files-grid {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
      }
      .file-chip {
        padding: 9px 10px;
        border-radius: 14px;
        border: 1px solid rgba(53, 80, 94, 0.72);
        background: linear-gradient(180deg, rgba(12, 22, 30, 0.94), rgba(11, 19, 27, 0.88));
      }
      .file-chip strong {
        display: block;
        font-size: 12px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .file-chip span {
        display: block;
        margin-top: 4px;
        font-size: 13px;
        font-weight: 700;
      }
      .hero-controls {
        display: grid;
        gap: 10px;
        padding: 12px;
        border-radius: 18px;
        border: 1px solid rgba(53, 80, 94, 0.78);
        background: rgba(8, 16, 23, 0.32);
      }
      .hero-hint {
        margin: 0;
        color: rgba(235, 245, 247, 0.78);
        font-size: 13px;
        line-height: 1.45;
      }
      .button-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
      }
      button {
        appearance: none;
        border: none;
        border-radius: 12px;
        padding: 11px 14px;
        font: inherit;
        font-size: 13px;
        font-weight: 700;
        cursor: pointer;
        transition: transform 120ms ease, background 120ms ease, border-color 120ms ease;
      }
      button:hover { transform: translateY(-1px); }
      button:disabled {
        opacity: 0.6;
        cursor: default;
        transform: none;
      }
      .button-primary {
        background: linear-gradient(180deg, #44d2c2, #2fb6a7);
        color: #062322;
      }
      .button-secondary {
        background: rgba(68, 210, 194, 0.1);
        border: 1px solid rgba(68, 210, 194, 0.26);
        color: #d3f7f2;
      }
      .button-ghost {
        background: rgba(255, 255, 255, 0.03);
        border: 1px solid rgba(53, 80, 94, 0.86);
        color: var(--ink);
      }
      .button-danger {
        background: rgba(251, 113, 133, 0.1);
        border: 1px solid rgba(251, 113, 133, 0.24);
        color: #ffd7dd;
      }
      .hero-status {
        min-height: 18px;
        color: var(--muted);
        font-size: 12px;
      }
      .hero-meta {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
      }
      .tabs {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        padding: 14px 18px 0;
      }
      .tab-button {
        background: transparent;
        border: 1px solid transparent;
        color: var(--muted);
        padding: 10px 12px;
        border-radius: 999px;
      }
      .tab-button[aria-selected="true"] {
        background: var(--accent-soft);
        border-color: rgba(68, 210, 194, 0.22);
        color: #d7faf5;
      }
      .content {
        padding: 14px 18px 18px;
      }
      .panel {
        display: grid;
        gap: 14px;
      }
      .section {
        padding: 16px;
        border-radius: 18px;
        border: 1px solid var(--line);
        background: linear-gradient(180deg, rgba(16, 28, 38, 0.96), rgba(12, 22, 30, 0.92));
        box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.02), 0 12px 30px rgba(0, 0, 0, 0.12);
      }
      .section h2,
      .section h3 {
        margin: 0 0 6px;
        font-size: 15px;
        letter-spacing: -0.01em;
      }
      .section-copy {
        margin: 0 0 14px;
        color: var(--muted);
        font-size: 13px;
        line-height: 1.45;
      }
      .grid-2 {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      .grid-3 {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;
      }
      label {
        display: grid;
        gap: 7px;
        font-size: 13px;
        color: #dce7ea;
      }
      .label-copy {
        color: var(--muted);
        font-size: 12px;
        line-height: 1.4;
      }
      input[type="text"],
      input[type="password"],
      input[type="number"],
      textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid rgba(53, 80, 94, 0.86);
        background: rgba(5, 12, 17, 0.8);
        color: var(--ink);
        padding: 12px 13px;
        font: inherit;
      }
      input[type="checkbox"] {
        width: 16px;
        height: 16px;
        accent-color: var(--accent);
      }
      .checkbox-row {
        display: flex;
        align-items: center;
        gap: 10px;
        min-height: 48px;
        padding: 0 2px;
      }
      .metrics {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 10px;
      }
      .metric {
        padding: 12px;
        border-radius: 16px;
        border: 1px solid rgba(53, 80, 94, 0.78);
        background: linear-gradient(180deg, rgba(14, 26, 34, 0.95), rgba(10, 18, 24, 0.94));
      }
      .metric-label {
        font-size: 11px;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
      }
      .metric-value {
        margin-top: 6px;
        font-size: 15px;
        font-weight: 700;
      }
      .subtext {
        margin-top: 4px;
        font-size: 12px;
        color: var(--muted);
      }
      details {
        border: 1px solid rgba(53, 80, 94, 0.68);
        border-radius: 15px;
        background: rgba(8, 16, 23, 0.28);
      }
      details summary {
        cursor: pointer;
        list-style: none;
        padding: 13px 14px;
        font-weight: 700;
      }
      details summary::-webkit-details-marker { display: none; }
      .details-body {
        padding: 0 14px 14px;
      }
      pre {
        margin: 0;
        padding: 12px;
        overflow: auto;
        border-radius: 14px;
        border: 1px solid rgba(53, 80, 94, 0.7);
        background: rgba(5, 12, 17, 0.9);
        color: #d3e8ee;
        font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      @media (max-width: 900px) {
        .hero-grid,
        .grid-2,
        .grid-3,
        .metrics,
        .files-grid {
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 640px) {
        main {
          width: min(100%, calc(100% - 18px));
          margin: 10px auto 24px;
        }
        .hero,
        .content {
          padding-left: 14px;
          padding-right: 14px;
        }
        .tabs {
          padding-left: 14px;
          padding-right: 14px;
        }
        .button-row {
          display: grid;
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="shell">
        <header class="hero">
          <div class="hero-grid">
            <div>
              <div class="hero-kicker">Local MCP Control Panel</div>
              <h1>Simple fal MCP</h1>
              <p class="lead">Connect fal, keep runtime defaults sane, and keep the MCP setup compact enough that an agent can reason about it quickly. The standard API key powers discovery and execution; an optional admin key unlocks usage-based cost reporting.</p>
              <div class="hero-badges" id="headerBadges"></div>
            </div>
            <div class="hero-side">
              <div class="files-strip">
                <div class="files-head">
                  <span class="files-title">Local Files</span>
                  <span class="files-dir">${escapeHtml(sharedFilesDir ?? configDir)}</span>
                </div>
                <div class="files-grid">
                  <div class="file-chip">
                    <strong>Config</strong>
                    <span>${escapeHtml(configFile)}</span>
                    ${sharedFilesDir ? "" : `<span class="files-dir">${escapeHtml(configDir)}</span>`}
                  </div>
                  <div class="file-chip">
                    <strong>Auth</strong>
                    <span>${escapeHtml(authFile)}</span>
                    ${sharedFilesDir ? "" : `<span class="files-dir">${escapeHtml(authDir)}</span>`}
                  </div>
                  <div class="file-chip">
                    <strong>State</strong>
                    <span>${escapeHtml(stateFile)}</span>
                    ${sharedFilesDir ? "" : `<span class="files-dir">${escapeHtml(stateDir)}</span>`}
                  </div>
                </div>
              </div>
              <div class="hero-controls">
                <p class="hero-hint" id="headerHint"></p>
                <div class="button-row">
                  <button class="button-primary" id="saveButton" type="button">Save Config</button>
                  <button class="button-secondary" id="refreshButton" type="button">Refresh Status</button>
                  <button class="button-danger" id="clearAuthButton" type="button">Clear Saved Keys</button>
                </div>
                <div class="hero-meta" id="headerMeta"></div>
                <div class="hero-status" id="actionStatus"></div>
              </div>
            </div>
          </div>
        </header>

        <nav class="tabs" aria-label="Setup sections">
          <button class="tab-button" type="button" data-tab="connection" aria-selected="true">Connection</button>
          <button class="tab-button" type="button" data-tab="defaults" aria-selected="false">Defaults</button>
          <button class="tab-button" type="button" data-tab="state" aria-selected="false">State</button>
        </nav>

        <section class="content">
          <div class="panel" id="panel-connection">
            <div class="section">
              <h2>Keys</h2>
              <p class="section-copy">The standard key is required for model search and execution. The admin key is optional and only used for usage-based cost reporting.</p>
              <div class="grid-2">
                <label>
                  <span>fal API Key</span>
                  <input id="apiKey" type="password" autocomplete="off" placeholder="Paste a standard fal key" />
                  <span class="label-copy" id="apiKeyNote"></span>
                </label>
                <label>
                  <span>Admin Key (optional)</span>
                  <input id="adminApiKey" type="password" autocomplete="off" placeholder="Paste an admin key only if you have one" />
                  <span class="label-copy" id="adminApiKeyNote"></span>
                </label>
              </div>
            </div>

            <div class="metrics">
              <div class="metric">
                <div class="metric-label">Run Key</div>
                <div class="metric-value" id="metricRunKey">Missing</div>
                <div class="subtext" id="metricRunKeySub">No stored key yet.</div>
              </div>
              <div class="metric">
                <div class="metric-label">Admin Cost Access</div>
                <div class="metric-value" id="metricAdmin">Disabled</div>
                <div class="subtext" id="metricAdminSub">Usage reporting stays in estimate mode.</div>
              </div>
              <div class="metric">
                <div class="metric-label">Request Cost Confidence</div>
                <div class="metric-value" id="metricCostConfidence">Estimated</div>
                <div class="subtext" id="metricCostConfidenceSub">No admin key detected.</div>
              </div>
            </div>
          </div>

          <div class="panel" id="panel-defaults" hidden>
            <div class="section">
              <h2>Execution Defaults</h2>
              <p class="section-copy">Keep these modest. They become the fallback behavior the agent relies on when a request does not override them.</p>
              <div class="grid-3">
                <label>
                  <span>Wait (ms)</span>
                  <input id="waitMs" type="number" min="1000" step="1000" />
                </label>
                <label>
                  <span>Poll Interval (ms)</span>
                  <input id="pollIntervalMs" type="number" min="100" step="100" />
                </label>
                <label>
                  <span>Model Search Limit</span>
                  <input id="modelSearchLimit" type="number" min="1" step="1" />
                </label>
                <label>
                  <span>Artifact Download Limit</span>
                  <input id="artifactDownloadLimit" type="number" min="1" step="1" />
                </label>
                <label>
                  <span>Object TTL (seconds)</span>
                  <input id="objectTtlSeconds" type="number" min="60" step="60" />
                </label>
                <label class="checkbox-row">
                  <input id="downloadOutputs" type="checkbox" />
                  <span>Download outputs into local workspaces</span>
                </label>
              </div>
            </div>

            <div class="section">
              <h2>Workspace</h2>
              <p class="section-copy">Generated files stay temporary by default. Keep only the outputs you explicitly copy out.</p>
              <div class="grid-2">
                <label>
                  <span>Workspace Root</span>
                  <input id="workspaceRootDir" type="text" />
                </label>
                <label>
                  <span>Auto Cleanup Hours</span>
                  <input id="workspaceAutoCleanupHours" type="number" min="0" step="1" />
                </label>
              </div>
            </div>

            <details>
              <summary>Advanced</summary>
              <div class="details-body">
                <div class="grid-2">
                  <label>
                    <span>Setup Web Auto-Stop (minutes)</span>
                    <input id="setupWebAutoStopMinutes" type="number" min="0" step="1" />
                    <span class="label-copy">Set to 0 to keep the local setup panel running until you stop it manually.</span>
                  </label>
                </div>
              </div>
            </details>
          </div>

          <div class="panel" id="panel-state" hidden>
            <div class="metrics">
              <div class="metric">
                <div class="metric-label">Workspaces</div>
                <div class="metric-value" id="stateWorkspaceCount">0</div>
                <div class="subtext" id="stateWorkspaceSub">No saved workspace state yet.</div>
              </div>
              <div class="metric">
                <div class="metric-label">Last Model Search</div>
                <div class="metric-value" id="stateModelCount">0</div>
                <div class="subtext" id="stateModelSub">No search session saved yet.</div>
              </div>
              <div class="metric">
                <div class="metric-label">Last Request History</div>
                <div class="metric-value" id="stateRequestCount">0</div>
                <div class="subtext" id="stateRequestSub">No request history saved yet.</div>
              </div>
            </div>

            <div class="section">
              <h2>Current State</h2>
              <p class="section-copy">This is the compact operational view the agent should be able to infer from quickly.</p>
              <div class="grid-2">
                <div class="metric">
                  <div class="metric-label">Last Usage Snapshot</div>
                  <div class="metric-value" id="stateUsageCount">0</div>
                  <div class="subtext" id="stateUsageSub">No usage session saved yet.</div>
                </div>
                <div class="metric">
                  <div class="metric-label">Last Run Pointer</div>
                  <div class="metric-value" id="stateLastRun">None</div>
                  <div class="subtext" id="stateLastRunSub">No run pointer saved yet.</div>
                </div>
              </div>
            </div>

            <details>
              <summary>Diagnostics</summary>
              <div class="details-body">
                <pre id="diagnosticsJson"></pre>
              </div>
            </details>
          </div>
        </section>
      </div>
    </main>

    <script>
      const setupToken = ${JSON.stringify(setupToken)};
      const state = {
        runtime: ${initialRuntimeJson},
        status: ${initialStatusJson}
      };

      const panelIds = ["connection", "defaults", "state"];

      function $(id) {
        const element = document.getElementById(id);
        if (!element) {
          throw new Error("Missing element: " + id);
        }
        return element;
      }

      function setText(id, value) {
        $(id).textContent = value;
      }

      function sourceLabel(source) {
        if (!source) return "not stored";
        if (source === "args") return "from args";
        if (source === "env") return "from env";
        return "stored locally";
      }

      function boolLabel(value, whenTrue, whenFalse) {
        return value ? whenTrue : whenFalse;
      }

      function sanitizeJsonForView(value) {
        return JSON.stringify(value, null, 2);
      }

      function syncRuntimeFromStatus() {
        if (state.status.defaults) state.runtime.defaults = state.status.defaults;
        if (state.status.workspace) state.runtime.workspace = state.status.workspace;
        if (state.status.misc) state.runtime.misc = state.status.misc;
      }

      function fillForm() {
        const runtime = state.runtime;
        const auth = state.status.auth || {};

        $("waitMs").value = String(runtime.defaults.waitMs ?? "");
        $("pollIntervalMs").value = String(runtime.defaults.pollIntervalMs ?? "");
        $("modelSearchLimit").value = String(runtime.defaults.modelSearchLimit ?? "");
        $("artifactDownloadLimit").value = String(runtime.defaults.artifactDownloadLimit ?? "");
        $("objectTtlSeconds").value = String(runtime.defaults.objectTtlSeconds ?? "");
        $("downloadOutputs").checked = Boolean(runtime.defaults.downloadOutputs);
        $("workspaceRootDir").value = String(runtime.workspace.rootDir ?? "");
        $("workspaceAutoCleanupHours").value = String(runtime.workspace.autoCleanupHours ?? "");
        $("setupWebAutoStopMinutes").value = String(runtime.misc.setupWebAutoStopMinutes ?? "");
        $("apiKey").value = "";
        $("adminApiKey").value = "";

        setText("apiKeyNote", auth.apiKeyPresent
          ? "A standard key is already present: " + sourceLabel(auth.source) + ". Leave blank to keep it."
          : "No stored standard key yet.");
        setText("adminApiKeyNote", auth.adminApiKeyPresent
          ? "An admin key is already present: " + sourceLabel(auth.adminSource) + ". Leave blank to keep it."
          : "Optional. Add only if you want usage-based cost reporting.");
      }

      function buildBadge(label, tone) {
        return '<span class="badge ' + tone + '"><span class="badge-dot"></span>' + label + '</span>';
      }

      function compactTailPath(value, segments) {
        if (!value) return "";
        const parts = String(value).split("/").filter(Boolean);
        if (!parts.length) return String(value);
        const tail = parts.slice(-Math.max(1, segments || 2)).join("/");
        return String(value).startsWith("/") ? tail : String(value);
      }

      function renderHeader() {
        const auth = state.status.auth || {};
        const capabilities = state.status.capabilities || {};
        const workspaceRoot = state.runtime.workspace.rootDir || "";
        const badges = [];
        badges.push(buildBadge(auth.apiKeyPresent ? "Run key ready" : "Run key missing", auth.apiKeyPresent ? "ok" : "warn"));
        badges.push(buildBadge(auth.adminApiKeyPresent ? "Admin key ready" : "Admin key optional", auth.adminApiKeyPresent ? "ok" : "subtle"));
        badges.push(buildBadge(capabilities.usageAvailable ? "Usage cost enabled" : "Cost in estimate mode", capabilities.usageAvailable ? "ok" : "subtle"));
        badges.push(buildBadge("Workspace ready", "subtle"));
        $("headerBadges").innerHTML = badges.join("");
        setText("headerHint", state.status.hint || "Configure fal and save the keys you want this MCP to use.");
        setText("headerMeta", workspaceRoot
          ? "Workspace root: " + compactTailPath(workspaceRoot, 2) + ". Full path is in Defaults."
          : "Workspace root is configured in Defaults.");
      }

      function renderConnectionMetrics() {
        const auth = state.status.auth || {};
        const capabilities = state.status.capabilities || {};
        setText("metricRunKey", auth.apiKeyPresent ? "Ready" : "Missing");
        setText("metricRunKeySub", auth.apiKeyPresent ? sourceLabel(auth.source) : "No stored key yet.");
        setText("metricAdmin", auth.adminApiKeyPresent ? "Enabled" : "Disabled");
        setText("metricAdminSub", auth.adminApiKeyPresent
          ? "Usage reporting unlocked via " + sourceLabel(auth.adminSource) + "."
          : "Usage reporting stays in estimate mode.");
        setText("metricCostConfidence", capabilities.requestCostConfidence === "usage_window" ? "Usage Window" : "Estimated");
        setText("metricCostConfidenceSub", capabilities.usageAvailable
          ? "Request cost can use saved usage buckets."
          : "Add an admin key for stronger cost signals.");
      }

      function renderState() {
        const savedState = state.status.state || {};
        const lastModelSearch = savedState.lastModelSearch || null;
        const lastRequestHistory = savedState.lastRequestHistory || null;
        const lastUsage = savedState.lastUsage || null;

        setText("stateWorkspaceCount", String(savedState.workspaceCount || 0));
        setText("stateWorkspaceSub", savedState.lastWorkspaceId
          ? "Last workspace: " + savedState.lastWorkspaceId
          : "No saved workspace state yet.");
        setText("stateModelCount", String(lastModelSearch ? lastModelSearch.count || 0 : 0));
        setText("stateModelSub", lastModelSearch
          ? ((lastModelSearch.query || "recent search") + (lastModelSearch.hasMore ? " with more pages" : ""))
          : "No search session saved yet.");
        setText("stateRequestCount", String(lastRequestHistory ? lastRequestHistory.count || 0 : 0));
        setText("stateRequestSub", lastRequestHistory
          ? ((lastRequestHistory.endpointId || "request history") + (lastRequestHistory.hasMore ? " with more pages" : ""))
          : "No request history saved yet.");
        setText("stateUsageCount", String(lastUsage ? lastUsage.count || 0 : 0));
        setText("stateUsageSub", lastUsage
          ? ((lastUsage.endpointIds && lastUsage.endpointIds.length ? lastUsage.endpointIds.join(", ") : "saved usage window") + (lastUsage.hasMore ? " with more pages" : ""))
          : "No usage session saved yet.");
        setText("stateLastRun", savedState.lastRunId || "None");
        setText("stateLastRunSub", savedState.lastRunId
          ? "Latest saved run pointer."
          : "No run pointer saved yet.");
        setText("diagnosticsJson", sanitizeJsonForView(state.status));
      }

      function renderAll() {
        syncRuntimeFromStatus();
        fillForm();
        renderHeader();
        renderConnectionMetrics();
        renderState();
      }

      function setActionStatus(message, isError) {
        const element = $("actionStatus");
        element.textContent = message || "";
        element.style.color = isError ? "#ffd7dd" : "";
      }

      async function apiRequest(method, path, body) {
        const response = await fetch(path + "?token=" + encodeURIComponent(setupToken), {
          method,
          headers: {
            "Content-Type": "application/json",
            "x-setup-token": setupToken
          },
          body: body ? JSON.stringify(body) : undefined
        });
        const payload = await response.json();
        if (!response.ok || payload.ok === false) {
          throw new Error(payload.error || ("Request failed: " + response.status));
        }
        return payload;
      }

      async function refreshStatus() {
        setActionStatus("Refreshing status...", false);
        try {
          state.status = await apiRequest("GET", "/api/status");
          renderAll();
          setActionStatus("Status refreshed.", false);
        } catch (error) {
          setActionStatus(error instanceof Error ? error.message : String(error), true);
        }
      }

      function readNumber(id) {
        const raw = $(id).value.trim();
        if (!raw) return undefined;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : undefined;
      }

      function buildPatch() {
        const patch = {
          fal: {},
          defaults: {
            waitMs: readNumber("waitMs"),
            pollIntervalMs: readNumber("pollIntervalMs"),
            modelSearchLimit: readNumber("modelSearchLimit"),
            artifactDownloadLimit: readNumber("artifactDownloadLimit"),
            objectTtlSeconds: readNumber("objectTtlSeconds"),
            downloadOutputs: $("downloadOutputs").checked
          },
          workspace: {
            rootDir: $("workspaceRootDir").value.trim() || undefined,
            autoCleanupHours: readNumber("workspaceAutoCleanupHours")
          },
          misc: {
            setupWebAutoStopMinutes: readNumber("setupWebAutoStopMinutes")
          }
        };

        const apiKey = $("apiKey").value.trim();
        const adminApiKey = $("adminApiKey").value.trim();
        if (apiKey) patch.fal.apiKey = apiKey;
        if (adminApiKey) patch.fal.adminApiKey = adminApiKey;
        return patch;
      }

      async function saveConfig() {
        setActionStatus("Saving config...", false);
        try {
          await apiRequest("POST", "/api/config", buildPatch());
          await refreshStatus();
          setActionStatus("Config saved.", false);
        } catch (error) {
          setActionStatus(error instanceof Error ? error.message : String(error), true);
        }
      }

      async function clearAuth() {
        setActionStatus("Clearing saved keys...", false);
        try {
          await apiRequest("POST", "/api/auth/clear", {});
          $("apiKey").value = "";
          $("adminApiKey").value = "";
          await refreshStatus();
          setActionStatus("Saved keys cleared.", false);
        } catch (error) {
          setActionStatus(error instanceof Error ? error.message : String(error), true);
        }
      }

      function setTab(nextTab) {
        for (const tabId of panelIds) {
          const active = tabId === nextTab;
          $("panel-" + tabId).hidden = !active;
          const button = document.querySelector('[data-tab="' + tabId + '"]');
          if (button) button.setAttribute("aria-selected", active ? "true" : "false");
        }
      }

      document.querySelectorAll("[data-tab]").forEach(button => {
        button.addEventListener("click", () => setTab(button.getAttribute("data-tab")));
      });
      $("saveButton").addEventListener("click", saveConfig);
      $("refreshButton").addEventListener("click", refreshStatus);
      $("clearAuthButton").addEventListener("click", clearAuth);

      if (location.search.includes("token=") && window.history.replaceState) {
        window.history.replaceState({}, document.title, location.pathname);
      }

      renderAll();
    </script>
  </body>
</html>`;
}
