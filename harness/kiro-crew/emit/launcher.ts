/** Portable command templates are materialized by setup before registration.
 * Crew shells hook command text; MCP receives raw argv, without another shell.
 * Non-brace markers survive the packager's invocation substitution. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { EmitContext } from "../../../scripts/manifest-types.ts";
import type { Collector } from "./types.ts";

export const BUN = "__AIDLC_KIRO_CREW_BUN__";
export const APP_ROOT = "__AIDLC_KIRO_CREW_APP_ROOT__";
export const CREW_HOME = "__AIDLC_KIRO_CREW_HOME__";
export const PORTABLE_PLACEHOLDERS = {
  [BUN]: "Absolute Bun executable path",
  [APP_ROOT]: "Absolute installed App Kit root",
  [CREW_HOME]: "Absolute Crew home directory",
} as const;
const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const HOOK_ARGV_TEMPLATE = [
  BUN, `${APP_ROOT}/hooks/aidlc-kiro-crew-hook-entry.ts`, "engine", "adapter", "kiro-crew", "<Event>",
] as const;
export const CREW_INVOKE = quote(`${APP_ROOT}/aidlc-kiro-crew-bootstrap.sh`);
export const CREW_HOOK_INVOKE = HOOK_ARGV_TEMPLATE.slice(0, -1)
  .map((arg, index) => index < 2 ? quote(arg) : arg).join(" ");
export const MCP_FRAGMENT = {
  mcpServers: {
    engine: {
      command: BUN,
      args: [`${APP_ROOT}/mcp/aidlc-mcp-bridge.ts`, "mcp", "--crew-home", CREW_HOME],
      env: {},
    },
  },
};

/** Resolve app-owned prose before generic tokens; project engine stays relative. */
export function substituteLauncherInvocation(ctx: EmitContext, source: string): string {
  return ctx.substituteToken(
    source.replaceAll("{{INVOKE}}", CREW_INVOKE)
      .replaceAll(`bun ${ctx.harnessDir}/tools/aidlc.ts`, CREW_INVOKE),
  );
}

export const collectLauncherEmissions: Collector = (ctx) => [
  ...["aidlc-kiro-crew-launcher.sh", "aidlc-kiro-crew-bootstrap.sh"].map((name) => ({
    path: name,
    content: readFileSync(join(ctx.harnessRoot, "launcher", name), "utf-8"),
    mode: 0o755 as const,
  })),
  {
    path: "hooks/aidlc-kiro-crew-hook-entry.ts",
    content: readFileSync(join(ctx.harnessRoot, "hooks", "aidlc-kiro-crew-hook-entry.ts"), "utf-8"),
    mode: 0o644,
  },
  {
    path: "setup/aidlc-kiro-crew-setup.ts",
    content: readFileSync(join(ctx.harnessRoot, "setup", "aidlc-kiro-crew-setup.ts"), "utf-8"),
    mode: 0o644,
  },
  {
    path: "mcp/aidlc-mcp-bridge.ts",
    content: readFileSync(join(ctx.harnessRoot, "mcp", "aidlc-mcp-bridge.ts"), "utf-8"),
  },
  { path: "mcp.fragment.json", content: JSON.stringify(MCP_FRAGMENT, null, 2) },
];
