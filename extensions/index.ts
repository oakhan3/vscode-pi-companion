/**
 * PI Companion Extension
 *
 * Connects to the VS Code extension via SSE for real-time context updates.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import * as http from "http";
import { execSync } from "child_process";
import { Type } from "@sinclair/typebox";
import {
  MAX_INJECTED_CHARS,
  MAX_INJECTED_LINES,
  PORT_VALIDATE_TIMEOUT_MS,
  RECONNECT_DELAY_MS,
} from "./config";

const CONNECTION_DIR = path.join(os.tmpdir(), "pi-companion");

interface IdeContext {
  workspaceState: {
    openFiles: Array<{
      path: string;
      timestamp: number;
      isActive?: boolean;
      isDirty?: boolean;
      selectedText?: string;
      cursor?: { line: number; character: number };
      selectionStart?: { line: number; character: number };
      selectionEnd?: { line: number; character: number };
      content?: string;
    }>;
    isTrusted: boolean;
    workspacePath: string;
  };
}

interface ConnectionInfo {
  port: number;
  workspacePath: string;
  authToken: string;
}

let currentContext: IdeContext | undefined;
let currentCtx: ExtensionContext | undefined;
let lastInjectedKey: string | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let sseRequest: http.ClientRequest | undefined;
let isConnected = false;

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_INJECTED_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_INJECTED_CHARS), truncated: true };
}

function isRunningInVSCode(): boolean {
  return process.env.TERM_PROGRAM === "vscode";
}

function isExtensionInstalled(): boolean {
  try {
    const result = execSync("code --list-extensions", { encoding: "utf8" });
    return result.includes("ravshansbox.vscode-pi-companion");
  } catch {
    return false;
  }
}

function installFromMarketplace(ctx: ExtensionContext): void {
  try {
    execSync("code --install-extension ravshansbox.vscode-pi-companion --force", { stdio: "pipe" });
    ctx.ui.notify("PI Companion: VS Code extension installed. Reload window to activate.", "info");
  } catch {
    ctx.ui.notify("PI Companion: Failed to auto-install VS Code extension.", "warning");
  }
}

function ensureVSCodeExtensionInstalled(ctx: ExtensionContext): void {
  if (!isRunningInVSCode()) return;
  if (!isExtensionInstalled()) {
    installFromMarketplace(ctx);
  }
}

function readLatestConnectionInfo(): ConnectionInfo | undefined {
  try {
    const files = fs.readdirSync(CONNECTION_DIR);
    const connectionFiles = files
      .filter((f) => f.startsWith("connection-") && f.endsWith(".json"))
      .map((f) => ({
        path: path.join(CONNECTION_DIR, f),
        mtime: fs.statSync(path.join(CONNECTION_DIR, f)).mtime.getTime(),
      }))
      .sort((a, b) => b.mtime - a.mtime);

    for (const file of connectionFiles) {
      try {
        const content = fs.readFileSync(file.path, "utf-8");
        const info = JSON.parse(content) as ConnectionInfo;
        if (typeof info.port === "number" && info.port > 0) {
          return info;
        }
      } catch {
        // Ignore malformed files and try the next one.
      }
    }
  } catch {
    // No connection files found.
  }
  return undefined;
}

function isPortAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port,
        path: "/context",
        timeout: PORT_VALIDATE_TIMEOUT_MS,
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}

async function getLivePort(): Promise<number | undefined> {
  const info = readLatestConnectionInfo();
  if (!info) return undefined;
  return (await isPortAlive(info.port)) ? info.port : undefined;
}

function updateWidget(): void {
  if (!currentCtx) return;

  if (!isConnected) {
    currentCtx.ui.setWidget("pi-companion", ["vscode: disconnected"]);
    return;
  }

  if (!currentContext) {
    currentCtx.ui.setWidget("pi-companion", ["vscode: connected"]);
    return;
  }

  if (!currentContext.workspaceState.openFiles.length) {
    currentCtx.ui.setWidget("pi-companion", ["vscode: no files"]);
    return;
  }

  const { workspaceState } = currentContext;
  const activeFile = workspaceState.openFiles.find((f) => f.isActive) || workspaceState.openFiles[0];
  const filenames = workspaceState.openFiles.map((f) => f.path.split("/").pop() || f.path);

  if (activeFile) {
    const filename = activeFile.path.split("/").pop() || activeFile.path;
    const isDirty = !!activeFile.isDirty;
    let location = "";
    if (activeFile.selectionStart && activeFile.selectionEnd) {
      const start = activeFile.selectionStart.line;
      const end = activeFile.selectionEnd.line;
      location = start === end ? ` L${start}` : ` L${start}:${end}`;
    }
    const suffix = filenames.length === 1 ? `${location}` : `${location} +${filenames.length - 1}`;
    currentCtx.ui.setWidget("pi-companion", (_tui, theme) => {
      const marker = isDirty ? theme.fg("warning", theme.bold("*")) : "";
      return {
        render: () => [`${filename}${marker}${suffix}`],
        invalidate: () => {},
      };
    });
    return;
  }

  currentCtx.ui.setWidget("pi-companion", [filenames.join(", ")]);
}

async function connectSSE(): Promise<void> {
  const port = await getLivePort();
  if (!port) return;

  if (sseRequest) {
    sseRequest.destroy();
    sseRequest = undefined;
  }

  sseRequest = http.get(
    {
      hostname: "127.0.0.1",
      port,
      path: "/context/stream",
    },
    (res) => {
      isConnected = true;
      updateWidget();
      let buffer = "";

      res.on("data", (chunk: string) => {
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (!data || data === "[object Object]") continue;
          try {
            currentContext = JSON.parse(data);
            updateWidget();
          } catch {
            // Ignore malformed SSE payloads.
          }
        }
      });

      res.on("end", scheduleReconnect);
      res.on("error", scheduleReconnect);
    },
  );

  sseRequest.on("error", scheduleReconnect);
}

function scheduleReconnect(): void {
  if (reconnectTimer || !currentCtx) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectSSE();
  }, RECONNECT_DELAY_MS);
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async () => {
    if (!currentContext) return;

    const activeFile = currentContext.workspaceState.openFiles.find((f) => f.isActive);
    if (!activeFile) return;

    let contextText = "";

    const dirtyNote = activeFile.isDirty ? " (unsaved changes - on-disk content differs from what is shown)" : "";

    if (activeFile.selectedText) {
      // NOTE: Apply the same char cap as the content path so injected selections stay bounded.
      const { text: selection, truncated } = capText(activeFile.selectedText);
      const selectionNote = truncated ? ` (truncated to ${MAX_INJECTED_CHARS} chars)` : "";
      contextText = `Current selection in ${activeFile.path}${dirtyNote}${selectionNote}:\n\`\`\`\n${selection}\n\`\`\``;
    } else if (activeFile.content) {
      const lines = activeFile.content.split("\n");
      const lineCapped = lines.length > MAX_INJECTED_LINES;
      const { text: content, truncated: charCapped } = capText(lines.slice(0, MAX_INJECTED_LINES).join("\n"));
      const notes: string[] = [];
      if (lineCapped) notes.push(`first ${MAX_INJECTED_LINES} lines`);
      if (charCapped) notes.push(`truncated to ${MAX_INJECTED_CHARS} chars`);
      const contentNote = notes.length ? ` (${notes.join(", ")})` : "";
      contextText = `Current file ${activeFile.path}${dirtyNote}${contentNote}:\n\`\`\`\n${content}\n\`\`\``;
    }

    if (!contextText) return;

    // NOTE: Skip re-sending an identical block. When the active context is unchanged
    //       since the last turn, inject a one-line marker instead of the full block
    //       so the agent stays oriented to the active file without spending tokens.
    if (contextText === lastInjectedKey) {
      return {
        message: {
          customType: "pi-companion",
          content: `Current open file: ${activeFile.path}`,
          display: false,
        },
      };
    }

    lastInjectedKey = contextText;
    return {
      message: {
        customType: "pi-companion",
        content: contextText,
        display: false,
      },
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    ensureVSCodeExtensionInstalled(ctx);

    const port = await getLivePort();
    if (port) {
      await connectSSE();
    } else {
      ctx.ui.notify("PI Companion: VS Code companion server not running. Run 'PI Companion: Start Server' in VS Code.", "warning");
    }
  });

  pi.on("session_shutdown", async () => {
    currentCtx = undefined;
    isConnected = false;
    lastInjectedKey = undefined;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (sseRequest) {
      sseRequest.destroy();
      sseRequest = undefined;
    }
  });

  pi.registerTool({
    name: "get_ide_context",
    label: "Get IDE Context",
    description: "Get the current IDE context: open files, cursor position, and selection",
    parameters: Type.Object({}),
    async execute() {
      if (!currentContext) {
        return {
          content: [{ type: "text", text: "No IDE context available. Make sure the PI Companion VS Code extension is installed and running." }],
          details: {},
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify(currentContext, null, 2) }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "get_current_file",
    label: "Get Current File",
    description: "Get the content of the currently active file in the IDE",
    parameters: Type.Object({}),
    async execute() {
      if (!currentContext) {
        return { content: [{ type: "text", text: "No IDE context available" }], details: {} };
      }
      const activeFile = currentContext.workspaceState.openFiles.find((f) => f.isActive);
      if (!activeFile) {
        return { content: [{ type: "text", text: "No active file" }], details: {} };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            path: activeFile.path,
            isDirty: activeFile.isDirty,
            cursor: activeFile.cursor,
            selection: activeFile.selectedText,
            content: activeFile.content,
          }, null, 2),
        }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "list_open_files",
    label: "List Open Files",
    description: "List all files currently open in the IDE",
    parameters: Type.Object({}),
    async execute() {
      if (!currentContext) {
        return { content: [{ type: "text", text: "No IDE context available" }], details: {} };
      }
      const files = currentContext.workspaceState.openFiles.map((f) => ({
        path: f.path,
        isActive: f.isActive,
        isDirty: f.isDirty,
        cursor: f.cursor,
        hasSelection: !!f.selectedText,
      }));
      return { content: [{ type: "text", text: JSON.stringify(files, null, 2) }], details: {} };
    },
  });
}
