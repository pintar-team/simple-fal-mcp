import { z } from "zod";

import { cleanupWorkspaces, deleteWorkspace, getWorkspaceDetails } from "../../fal/workspaces.js";
import { okResponse, type FalToolContext } from "../shared.js";

const workspaceSchema = z.object({
  action: z.enum(["list", "get", "delete", "cleanup"]).describe("list and get inspect workspaces, delete removes one, cleanup prunes old temporary workspaces."),
  workspaceId: z.string().optional(),
  olderThanHours: z.number().nonnegative().optional()
});

export function registerFalWorkspaceTool(context: FalToolContext): void {
  context.server.registerTool(
    "fal_workspace",
    {
      title: "fal workspace manager",
      description: "Inspect saved workspaces and runs, including upload and artifact issues, or delete and clean temporary workspaces.",
      inputSchema: workspaceSchema
    },
    async input => {
      await context.reloadRuntime("fal_workspace");
      const runtime = context.getRuntime();
      const state = context.getPersistedState();

      if (input.action === "list") {
        return okResponse({
          ok: true,
          action: "list",
          count: state.workspaces?.items.length ?? 0,
          items: state.workspaces?.items ?? []
        });
      }

      if (input.action === "get") {
        if (!input.workspaceId) {
          throw new Error("fal_workspace action=get requires workspaceId.");
        }
        const details = await getWorkspaceDetails(runtime, state, input.workspaceId);
        if (!details) {
          throw new Error(`Workspace not found: ${input.workspaceId}`);
        }
        return okResponse({
          ok: true,
          action: "get",
          workspace: details
        });
      }

      if (input.action === "delete") {
        if (!input.workspaceId) {
          throw new Error("fal_workspace action=delete requires workspaceId.");
        }
        const nextState = await deleteWorkspace(runtime, state, input.workspaceId);
        await context.savePersistedState(nextState, "fal_workspace_delete");
        return okResponse({
          ok: true,
          action: "delete",
          workspaceId: input.workspaceId
        });
      }

      const cleanupResult = await cleanupWorkspaces(
        runtime,
        state,
        input.olderThanHours ?? runtime.workspace.autoCleanupHours
      );
      await context.savePersistedState(cleanupResult.state, "fal_workspace_cleanup");
      return okResponse({
        ok: true,
        action: "cleanup",
        deleted: cleanupResult.deleted,
        deletedCount: cleanupResult.deleted.length
      });
    }
  );
}
