import { writeJsonFile } from "../runtime/files.js";
import type { PersistedState, RunRecord, RuntimeConfig } from "../runtime.js";
import { materializeArtifactsToWorkspace } from "./result.js";
import { saveRunRecord } from "./workspaces.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null
    ? value as JsonRecord
    : null;
}

export async function materializeRunResult(
  runtime: RuntimeConfig,
  state: PersistedState,
  run: RunRecord,
  result: unknown
): Promise<{
  nextState: PersistedState;
  updatedRun: RunRecord;
  rawResultPath: string | null;
  artifacts: RunRecord["artifacts"];
  artifactIssues: NonNullable<RunRecord["artifactIssues"]>;
  publicResult: unknown;
}> {
  if (run.responsePath) {
    await writeJsonFile(run.responsePath, result);
  }

  const resultRecord = asRecord(result);
  const materialized = run.artifactsDir
    ? await materializeArtifactsToWorkspace(
        resultRecord?.data,
        run.artifactsDir,
        runtime.defaults.artifactDownloadLimit,
        runtime.defaults.downloadOutputs
      )
    : {
        artifacts: run.artifacts,
        artifactIssues: run.artifactIssues ?? [],
        publicPayload: resultRecord?.data
      };

  const updatedRun: RunRecord = {
    ...run,
    updatedAt: new Date().toISOString(),
    status: "COMPLETED",
    artifacts: materialized.artifacts,
    artifactIssues: materialized.artifactIssues,
    error: undefined,
    providerFailure: undefined
  };
  const nextState = await saveRunRecord(runtime, state, updatedRun);

  return {
    nextState,
    updatedRun,
    rawResultPath: updatedRun.responsePath ?? null,
    artifacts: materialized.artifacts,
    artifactIssues: materialized.artifactIssues,
    publicResult: resultRecord
      ? {
          ...resultRecord,
          data: materialized.publicPayload
        }
      : result
  };
}
