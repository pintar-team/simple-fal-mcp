# simple-fal-mcp

Model Context Protocol (MCP) server for Codex and Claude Code with fal model discovery, execution, pricing, request follow-up, temp workspaces, and local media post-process.

Current scope:
- normal fal model endpoints only
- queue and sync execution
- image, video, and audio generation workflows
- local temp workspace management and media finishing
- no realtime/websocket flows in v1

![Conceptual fal MCP visual](img/fal-mcp-concept.webp)

## Tools

- `fal_status`: always available; returns config/auth/capability state, setup-web state, media availability, saved cursors, and workspace summary.
- `fal_setup_web`: local setup panel controller with actions `status`, `start`, `stop`.
- `fal_model`: model discovery tool with actions `search`, `next`, `get`, `pricing`, `estimate`.
- `fal_cost`: pricing/cost tool with actions `price`, `estimate`, `usage`, `usage_next`, `request`.
- `fal_run`: submits one model run, supports local-file uploads, and saves request state in a temp workspace.
- `fal_request`: request follow-up tool with actions `status`, `wait`, `result`, `materialize`, `cancel`, `history`, `history_next`.
- `fal_workspace`: local workspace manager with actions `list`, `get`, `delete`, `cleanup`.
- `fal_media`: local media tool with actions `inspect`, `open`, `reveal`, `image_convert`, `image_resize`, `video_convert`, `video_trim`, `video_reverse`, `video_concat`, `image_sequence_to_video`, `extract_frame`, `mux_audio`, `audio_convert`, `audio_reverse`, `audio_concat`.

Quick flow examples:
- `fal_model({ "action": "search", "query": "kling image to video" })`
- `fal_model({ "action": "get", "endpointId": "fal-ai/kling-video/o1/standard/image-to-video", "schemaMode": "summary" })`
- `fal_run({ "endpointId": "fal-ai/nano-banana-2", "input": { "prompt": "..." } })`
- `fal_request({ "action": "wait", "runId": "..." })`
- `fal_media({ "action": "image_resize", "workspaceId": "...", "inputPath": "runs/.../artifacts/01-images-0.png", "width": 1280, "height": 720, "fit": "cover" })`

## Install (npx)

Requirements:
- Node `>= 20.19.0`
- `ffmpeg` and `ffprobe` for video/audio actions

### Codex

```bash
codex mcp remove simple-fal
codex mcp add simple-fal -- \
  npx -y simple-fal-mcp@latest
```

Ask your agent to run `fal_status`, call `fal_setup_web` with `action: "start"` if needed, and then send you `setupWeb.url`.

Optional: pass keys via env when adding:

```bash
codex mcp add simple-fal -- \
  --env FAL_KEY="$FAL_KEY" \
  --env FAL_ADMIN_KEY="$FAL_ADMIN_KEY" \
  -- npx -y simple-fal-mcp@latest
```

### Claude Code

```bash
claude mcp remove simple-fal
claude mcp add --transport stdio simple-fal -- \
  npx -y simple-fal-mcp@latest
```

Ask Claude Code to run `fal_status`, call `fal_setup_web` with `action: "start"` if needed, and then share `setupWeb.url`.

Optional: pass keys via env when adding:

```bash
claude mcp add --transport stdio \
  --env FAL_KEY="$FAL_KEY" \
  --env FAL_ADMIN_KEY="$FAL_ADMIN_KEY" \
  simple-fal -- \
  npx -y simple-fal-mcp@latest
```

## How To Use

Think of `simple-fal-mcp` as your "fal execution layer":
- discover live models
- inspect schema before spending money
- check price or estimate cost
- run with raw input and optional local-file uploads
- continue by saved `runId` or `requestId`
- finish outputs locally in a temp workspace

### Typical flow

1. Add the MCP server with the `npx` install command above.

2. Ask your agent for setup status:
- `Run fal_status and tell me what is missing.`

3. If needed, ask for the setup link:
- `If setup web is not running, call fal_setup_web with action=start and give me setupWeb.url.`

4. Open the link, save the fal key, and optionally save an admin key.
   In some clients, you may need to restart the agent process after key changes so all tools see refreshed auth cleanly.

5. Search and inspect before running:
- `Search fal for a Kling first/last-frame video model.`
- `Show me the schema summary and upload pointer hints for this model.`
- `Show me the live price and estimate a 5-second run.`

6. Run the model:
- `Submit this fal run and return the request id immediately.`
- `Wait for that run and fetch the result when it is done.`

7. Finish locally if needed:
- `Resize this frame to 1280x720 with cover.`
- `Mux this audio onto the video.`
- `Open the final file.`

8. Clean up later:
- `Show me the last workspace.`
- `Clean old fal temp workspaces.`

### What to ask your agent (examples)

- Setup:
  - `Please configure simple-fal and give me the setup link.`
- Discovery:
  - `Find a cheap image-to-video model and show me the schema summary.`
- Pricing:
  - `Show me the live price for this endpoint and estimate a 5-second run.`
- Execution:
  - `Run this fal endpoint with these local files and save everything to a temp workspace.`
- Follow-up:
  - `Wait for my last fal run and fetch the result if it is done.`
- Local media:
  - `Resize this image to 1280x720 cover, reverse the final video, and open it.`

## Copy-Paste For AGENTS.md / CLAUDE.md

You can add explicit usage instructions like this:

```txt
If user uses simple-fal-mcp:

1) Setup flow
- Call fal_status.
- If setup is incomplete, call fal_setup_web(action=start) and return setupWeb.url.
- Tell user to open the local setup page and save the key.
- When setup is finished or user asks to close it, call fal_setup_web(action=stop).

2) Discovery and pricing
- Use fal_model(action=search) to find endpoints.
- Use fal_model(action=get, schemaMode=summary) before requesting raw OpenAPI.
- Use fal_cost(action=price) or fal_cost(action=estimate) before expensive runs when useful.

3) Run flow
- Prefer fal_run with wait=submit.
- Use uploadFiles for local files instead of pasting inline data.
- Follow queued runs with fal_request(action=wait|status|result).
- Use fal_request(action=materialize) if the provider run finished but local files are missing.

4) Workspace and media
- Prefer workspace-relative follow-up by runId/workspaceId.
- Use fal_media for local resize/convert/trim/mux/reveal/open steps.
- Keep final files by copying them out of the temp workspace.

5) Safety
- Never expose fal keys, admin keys, or setup tokens in user-visible messages.
- Do not claim realtime/websocket support in v1.
```

## Configuration

Default paths:
- `$XDG_CONFIG_HOME/simple-fal-mcp/config.json`
- `$XDG_CONFIG_HOME/simple-fal-mcp/auth.json`
- `$XDG_CONFIG_HOME/simple-fal-mcp/state.json`
- or `~/.config/simple-fal-mcp/...`

File roles:
- `config.json`: runtime defaults and workspace settings
- `auth.json`: fal API key and optional admin key
- `state.json`: saved cursors, request history state, usage cursor state, and workspace index

Env precedence:
1. CLI args
2. environment variables
3. config/auth/state files

Supported env vars:
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

Useful CLI args:
- `--fal-key`
- `--fal-admin-key`
- `--config`
- `--auth`
- `--state`
- `--setup-host`
- `--setup-port`
- `--setup-token`

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

These files are temp state, not permanent storage. If you want to keep an output, copy it out of the workspace.

## Local Development

```bash
bun install
bun run lint
bun run typecheck
bun run build
bun run self-test
```

## Notes

- Model discovery and schema inspection use fal’s live APIs instead of a hardcoded local catalog.
- `fal_run` defaults to queue mode with `wait: "submit"` and saves request state locally so later tools can recover by `runId`.
- Local uploads are resolved before submit and recorded in run metadata.
- Provider success and local artifact download are treated separately, so a completed run stays completed even when local mirroring needs a retry.
- The setup page does not expose the stored fal key or admin key back to the browser after either has been saved.
