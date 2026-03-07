import path from "node:path";
import process from "node:process";

import { runCommand } from "./command.js";

export type LocalSystemAction = "open" | "reveal";

export type LocalSystemCommand = {
  command: string;
  args: string[];
};

export function getLocalSystemCommand(
  action: LocalSystemAction,
  targetPath: string,
  platform: NodeJS.Platform = process.platform
): LocalSystemCommand {
  if (platform === "darwin") {
    return action === "reveal"
      ? { command: "open", args: ["-R", targetPath] }
      : { command: "open", args: [targetPath] };
  }

  if (platform === "win32") {
    if (action === "reveal") {
      return { command: "explorer", args: ["/select,", path.resolve(targetPath)] };
    }
    return { command: "explorer", args: [path.resolve(targetPath)] };
  }

  if (action === "reveal") {
    return { command: "xdg-open", args: [path.dirname(targetPath)] };
  }

  return { command: "xdg-open", args: [targetPath] };
}

export async function performLocalSystemAction(
  action: LocalSystemAction,
  targetPath: string
): Promise<LocalSystemCommand> {
  const command = getLocalSystemCommand(action, targetPath);
  await runCommand(command.command, command.args);
  return command;
}
