import type { FalClient, QueueStatus } from "@fal-ai/client";

type WaitForQueueOptions = {
  falClient: FalClient;
  endpointId: string;
  requestId: string;
  pollIntervalMs: number;
  timeoutMs: number;
  logs?: boolean;
  onStatus?: (status: QueueStatus) => Promise<void> | void;
};

type WaitForQueueResult = {
  latestStatus: QueueStatus;
  completed: boolean;
  timedOut: boolean;
  terminalFailure: boolean;
};

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    setTimeout(resolve, ms);
  });
}

function isTerminalFailure(status: string): boolean {
  return status === "FAILED" || status === "CANCELLED";
}

export async function waitForQueueCompletion(options: WaitForQueueOptions): Promise<WaitForQueueResult> {
  const deadline = Date.now() + options.timeoutMs;
  let latestStatus = await options.falClient.queue.status(options.endpointId, {
    requestId: options.requestId,
    logs: options.logs ?? true
  });
  await options.onStatus?.(latestStatus);

  while (Date.now() < deadline) {
    if (latestStatus.status === "COMPLETED") {
      return {
        latestStatus,
        completed: true,
        timedOut: false,
        terminalFailure: false
      };
    }
    if (isTerminalFailure(latestStatus.status)) {
      return {
        latestStatus,
        completed: false,
        timedOut: false,
        terminalFailure: true
      };
    }

    await sleep(options.pollIntervalMs);
    latestStatus = await options.falClient.queue.status(options.endpointId, {
      requestId: options.requestId,
      logs: options.logs ?? true
    });
    await options.onStatus?.(latestStatus);
  }

  return {
    latestStatus,
    completed: latestStatus.status === "COMPLETED",
    timedOut: latestStatus.status !== "COMPLETED" && !isTerminalFailure(latestStatus.status),
    terminalFailure: isTerminalFailure(latestStatus.status)
  };
}
