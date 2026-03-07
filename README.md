# simple-fal-mcp

Minimal MCP server for fal.ai model discovery, execution, and temporary local workspaces.

![Conceptual fal MCP visual](img/fal-mcp-concept.webp)

It is designed for agent workflows:
- find a model
- inspect the live schema
- run it with raw input and optional local-file uploads
- download result artifacts into a temp workspace
- inspect, convert, resize, trim, mux, or concat local media files
- inspect or clean that workspace later

V1 is generic across normal fal model endpoints, so it works for image, video, audio, and similar model types as long as the endpoint follows the standard model API and queue/sync patterns. Realtime and streaming-only surfaces are intentionally out of scope for this first version.

Local media post-process is also available through `fal_media`. Image work uses `sharp`. Video and audio actions use local `ffmpeg` and `ffprobe`, so those binaries need to be installed for that part of the MCP.

## Tools

- `fal_status`
  - Read runtime status, setup-web status, workspace root, saved model cursor, request history cursor, and workspace summary.
- `fal_setup_web`
  - `action: "status" | "start" | "stop"` manages the local setup UI with one tool.
- `fal_model`
  - `action: "search"` searches live fal models and saves the next cursor.
  - `action: "next"` continues the saved model cursor.
  - `action: "get"` fetches one or more model records and can include live OpenAPI. Summary mode also surfaces likely upload JSON pointers.
  - `action: "pricing"` fetches unit pricing for endpoints.
  - `action: "estimate"` estimates cost for a set of endpoint calls.
- `fal_cost`
  - `action: "price"` returns normalized live endpoint pricing.
  - `action: "estimate"` returns a cost estimate for one or more planned endpoint calls.
  - `action: "usage" | "usage_next"` returns saved usage buckets and summary data from fal usage APIs.
  - `action: "request"` combines request history, live pricing, inferred quantity, and usage-window lookup for one saved run or request ID.
- `fal_run`
  - Submit a model run with raw input, optional local-file uploads, and a local temp workspace.
  - Default `wait` is `submit`, so the tool returns `runId` and `requestId` immediately.
  - Use `wait: "complete"` only when you explicitly want one bounded inline wait.
- `fal_request`
  - `action: "status"` reads queue status.
  - `action: "wait"` polls a queue request until completion, terminal failure, or timeout.
  - `action: "result"` fetches queue results and downloads artifacts into the saved workspace when possible.
  - `action: "materialize"` retries local artifact download for a saved completed run.
  - `action: "cancel"` cancels a queued request.
  - `action: "history"` lists recent platform requests by endpoint and saves the next cursor.
  - `action: "history_next"` continues the saved request-history cursor.
- `fal_workspace`
  - `action: "list" | "get" | "delete" | "cleanup"` manages local temporary workspaces.
- `fal_media`
  - `action: "inspect"` returns local image/video/audio metadata.
  - `action: "image_convert" | "image_resize"` handles common image transforms with `sharp`.
  - `action: "video_convert" | "video_trim" | "video_concat" | "image_sequence_to_video" | "extract_frame" | "mux_audio"` handles common video post-process with `ffmpeg`.
  - `action: "audio_convert" | "audio_concat"` handles common audio conversions and glue steps with `ffmpeg`.

## Install

### Codex

```bash
codex mcp add simple-fal -- \
  node /absolute/path/to/simple-fal-mcp/build/index.js
```

### Claude Code

Add this MCP server entry to your Claude Code MCP config:

```json
{
  "mcpServers": {
    "simple-fal": {
      "command": "node",
      "args": ["/absolute/path/to/simple-fal-mcp/build/index.js"]
    }
  }
}
```

## Setup

The normal flow is:

1. Call `fal_setup_web` with `action: "start"`.
2. Open the returned local URL.
3. Paste the fal API key.
4. Optionally paste an admin key for usage-based cost reporting.
5. Adjust defaults if needed.
6. Save config.
7. Use `fal_model`, `fal_cost`, `fal_run`, `fal_request`, and `fal_workspace`.

For media post-process:
- use `fal_run` to generate files into a workspace
- pass returned local paths into `fal_media`
- keep final files by copying them out of the temp workspace

The setup web is local-only and lazy. It does not start automatically.

## Typical Use

### Find a model

Ask the agent:

```text
Search fal for a fast image-to-video model and show me the schema summary.
```

That should lead to:
- `fal_model` with `action: "search"`
- then `fal_model` with `action: "get"` and `schemaMode: "summary"` or `"both"`
- for file-based models, reuse the returned upload pointer hints like `/start_image_url` or `/image_urls/0`

### Run a model

Ask the agent:

```text
Run fal-ai/veo3/image-to-video with this local image and save outputs to a temp workspace.
```

That should lead to:
- `fal_run`
- optional `uploadFiles` mappings that replace JSON-pointer input paths with uploaded fal URLs
- by default, keep the submit response and follow with `fal_request`
- if you set `sync_mode: true` inside model input, fal will not show output data in request history previews

### Check pricing or cost

Ask the agent:

```text
Show me the live price for this endpoint, estimate the cost of a 5-second run, and inspect the cost of my last saved run.
```

That should lead to:
- `fal_cost` with `action: "price"`
- `fal_cost` with `action: "estimate"`
- `fal_cost` with `action: "request"`

### Continue a request later

Ask the agent:

```text
Check the status of my last fal run and get the result if it is done.
```

That should lead to:
- `fal_request` with `action: "wait"` and a `runId` or `requestId`
- optionally `fal_request` with `action: "result"` once it is finished
- if the provider result is ready but local files are missing, use `fal_request` with `action: "materialize"`

### Keep or clean artifacts

Ask the agent:

```text
Show me the last fal workspace and then clean old ones.
```

That should lead to:
- `fal_workspace` with `action: "get"`
- `fal_workspace` with `action: "cleanup"`

## Local Workspace Model

Generated outputs are stored under a local temp root by default:

```text
/tmp/simple-fal-mcp/workspaces/<workspace-id>/
```

Each run gets a directory with:
- `request.json`
- `status.json`
- `response.json`
- `artifacts/`

These files are local temp state, not permanent storage. If you want to keep an output, copy it out of the workspace.

## Configuration

Config is split into:

- `config.json`
  - runtime defaults and workspace settings
- `auth.json`
  - fal API key and optional admin key
- `state.json`
  - saved cursors and workspace index

Default location:

```text
~/.config/simple-fal-mcp/
```

## Environment Variables

- `FAL_KEY`
- `FAL_ADMIN_KEY`
- `FAL_DEFAULT_WAIT_MS`
- `FAL_POLL_INTERVAL_MS`
- `FAL_MODEL_SEARCH_LIMIT`
- `FAL_ARTIFACT_DOWNLOAD_LIMIT`
- `FAL_OBJECT_TTL_SECONDS`
- `FAL_DOWNLOAD_OUTPUTS`
- `FAL_WORKSPACE_ROOT`
- `FAL_WORKSPACE_AUTO_CLEANUP_HOURS`
- `FAL_SETUP_WEB_AUTO_STOP_MINUTES`

CLI args override env, and env overrides saved config.

## Local Development

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run self-test
```

Run locally:

```bash
bun run start
```

## Notes

- Model discovery and schema inspection use fal’s live platform APIs rather than a hardcoded local catalog.
- `fal_run` defaults to queue mode with `wait: "submit"` and saves request state locally so later tools can recover by `runId`.
- local uploads are resolved before submit and recorded in run metadata. Upload failure is treated as a real error instead of silently switching to inline data.
- provider success and local artifact download are treated separately, so a completed run stays completed even when local mirroring needs a retry.
- The setup page does not expose the stored fal key or admin key back to the browser after either has been saved.
