import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";

import sharp from "sharp";

import { inferUsageQuantity, parseUsageResponse } from "./fal/cost.js";
import { buildModelDetail } from "./fal/models.js";
import { isCommandAvailable, runCommand } from "./media/command.js";
import { inspectLocalFile } from "./media/inspect.js";
import { resizeImage } from "./media/images.js";
import { extractFrame } from "./media/video.js";
import { materializeArtifactsToWorkspace } from "./fal/result.js";
import { createRunId, ensureWorkspace, getWorkspaceDetails, saveRunRecord } from "./fal/workspaces.js";
import { writeJsonFile } from "./runtime/files.js";
import type { PersistedState, RunRecord, RuntimeConfig } from "./runtime.js";
import { buildRuntimeConfig } from "./runtime/config.js";
import { buildSetupPage } from "./setup-web/page.js";

function testSetupPageSecretHandling(): void {
  const runtime = buildRuntimeConfig({}, {});
  const html = buildSetupPage(
    "/tmp/config.json",
    "/tmp/auth.json",
    "/tmp/state.json",
    "token-123",
    runtime,
    {
      apiKey: "super-secret-key",
      adminApiKey: "super-secret-admin-key",
      source: "file",
      adminSource: "file"
    },
    {}
  );
  if (html.includes("super-secret-key")) {
    throw new Error("setup page leaked the stored API key");
  }
  if (html.includes("super-secret-admin-key")) {
    throw new Error("setup page leaked the stored admin API key");
  }
}

async function testWorkspaceRoundTrip(): Promise<void> {
  const rootDir = path.join(os.tmpdir(), `simple-fal-mcp-self-test-${Date.now()}`);
  const runtime: RuntimeConfig = {
    defaults: {
      waitMs: 1000,
      pollIntervalMs: 100,
      modelSearchLimit: 5,
      artifactDownloadLimit: 2,
      objectTtlSeconds: 60,
      downloadOutputs: true
    },
    workspace: {
      rootDir,
      autoCleanupHours: 0
    },
    misc: {
      setupWebAutoStopMinutes: 0
    }
  };
  const state: PersistedState = {
    workspaces: {
      items: []
    }
  };
  const workspace = await ensureWorkspace(runtime, state, "self-test");
  const runId = createRunId();
  const runPath = path.join(workspace.entry.path, "runs", runId, "response.json");
  await writeJsonFile(runPath, { ok: true });
  const record: RunRecord = {
    runId,
    workspaceId: workspace.entry.workspaceId,
    endpointId: "fal-ai/example",
    requestId: "req-123",
    mode: "queue",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "COMPLETED",
    inputPath: path.join(workspace.entry.path, "runs", runId, "request.json"),
    responsePath: runPath,
    artifactsDir: path.join(workspace.entry.path, "runs", runId, "artifacts"),
    artifacts: []
  };
  const nextState = await saveRunRecord(runtime, workspace.state, record);
  const details = await getWorkspaceDetails(runtime, nextState, workspace.entry.workspaceId);
  if (!details) {
    throw new Error("workspace details were not readable after save");
  }
}

function testOpenApiSummary(): void {
  const detail = buildModelDetail({
    endpoint_id: "fal-ai/example",
    title: "Example",
    openapi: {
      openapi: "3.0.0",
      paths: {
        "/": {
          post: {
            requestBody: {
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["prompt"],
                    properties: {
                      prompt: { type: "string", description: "Prompt" },
                      duration: { type: "integer" }
                    }
                  }
                }
              }
            },
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        video: {
                          type: "object",
                          properties: {
                            url: { type: "string" }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  }, "summary");
  if (!(detail.schemaSummary as Record<string, unknown>)?.input) {
    throw new Error("OpenAPI schema summary did not include input");
  }
}

async function testInlineArtifactMaterialization(): Promise<void> {
  const rootDir = path.join(os.tmpdir(), `simple-fal-mcp-inline-test-${Date.now()}`);
  const artifactsDir = path.join(rootDir, "artifacts");
  const payload = {
    images: [
      {
        url: "data:image/png;base64,aGVsbG8="
      }
    ]
  };

  const materialized = await materializeArtifactsToWorkspace(payload, artifactsDir, 1, true);
  if (materialized.artifacts.length !== 1) {
    throw new Error("inline artifact was not materialized");
  }
  const artifact = materialized.artifacts[0]!;
  if (!existsSync(artifact.localPath)) {
    throw new Error("inline artifact file was not written");
  }
  const publicPayload = materialized.publicPayload as Record<string, unknown>;
  const images = publicPayload.images as Array<Record<string, unknown>>;
  const firstUrl = images?.[0]?.url;
  if (typeof firstUrl !== "string" || firstUrl.startsWith("data:")) {
    throw new Error("public payload still exposed inline data");
  }
}

async function testMediaHelpers(): Promise<string> {
  const rootDir = path.join(os.tmpdir(), `simple-fal-mcp-media-test-${Date.now()}`);
  const sourceImage = path.join(rootDir, "source.png");
  const resizedImage = path.join(rootDir, "resized.webp");

  await mkdir(rootDir, { recursive: true });
  await sharp({
    create: {
      width: 96,
      height: 64,
      channels: 3,
      background: { r: 32, g: 48, b: 96 }
    }
  }).png().toFile(sourceImage);

  await resizeImage(sourceImage, resizedImage, {
    width: 48,
    format: "webp"
  });

  const resizedInfo = await inspectLocalFile(resizedImage);
  if ((resizedInfo.image as Record<string, unknown>)?.width !== 48) {
    throw new Error("image resize helper did not produce the expected width");
  }

  if (!(await isCommandAvailable("ffmpeg"))) {
    return "media_helpers_no_ffmpeg";
  }

  const sourceVideo = path.join(rootDir, "source.mp4");
  const framePath = path.join(rootDir, "frame.png");

  await runCommand("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    "color=c=#224466:s=160x90:d=1",
    "-pix_fmt",
    "yuv420p",
    sourceVideo
  ]);
  await extractFrame(sourceVideo, framePath, {
    timeSeconds: 0
  });
  if (!existsSync(framePath)) {
    throw new Error("ffmpeg frame extraction did not produce an output file");
  }

  return "media_helpers";
}

function testCostParsing(): void {
  const parsed = parseUsageResponse({
    time_series: [
      {
        endpoint_id: "fal-ai/example",
        start_date: "2026-03-07T10:00:00Z",
        end_date: "2026-03-07T10:01:00Z",
        quantity: 5,
        unit: "seconds",
        unit_price: 0.28,
        cost: 1.4,
        currency: "USD"
      }
    ],
    summary: {
      endpoint_id: "fal-ai/example",
      quantity: 5,
      unit: "seconds",
      unit_price: 0.28,
      cost: 1.4,
      currency: "USD"
    },
    next_cursor: "abc",
    has_more: true
  });
  if (parsed.items.length !== 1 || parsed.summary?.cost !== 1.4 || parsed.nextCursor !== "abc" || !parsed.hasMore) {
    throw new Error("usage response parsing did not preserve summary and cursor fields");
  }

  const quantity = inferUsageQuantity({
    duration: "5"
  }, "seconds");
  if (quantity?.quantity !== 5) {
    throw new Error("duration-based quantity inference failed");
  }

  const imageQuantity = inferUsageQuantity({
    num_images: 2
  }, "images");
  if (imageQuantity?.quantity !== 2) {
    throw new Error("image quantity inference failed");
  }
}

async function main(): Promise<void> {
  testSetupPageSecretHandling();
  await testWorkspaceRoundTrip();
  testOpenApiSummary();
  await testInlineArtifactMaterialization();
  testCostParsing();
  const mediaCheck = await testMediaHelpers();
  console.log(JSON.stringify({
    ok: true,
    checks: [
      "setup_page_secret_handling",
      "workspace_round_trip",
      "openapi_summary",
      "inline_artifact_materialization",
      "cost_parsing",
      mediaCheck
    ]
  }));
}

main().catch(err => {
  const message = err instanceof Error ? err.stack || err.message : String(err);
  console.error(message);
  process.exit(1);
});
