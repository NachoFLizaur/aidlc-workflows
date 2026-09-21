// Collect the host shell after project engine and runner generation.
// Only kiro-crew-app/ belongs to this emitter.
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EmitContext } from "../../scripts/manifest-types.ts";
import { collectAppEmissions } from "./emit/app.ts";
import { collectHookEmissions } from "./emit/hooks.ts";
import { collectLauncherEmissions, substituteLauncherInvocation } from "./emit/launcher.ts";
import { collectSkillEmissions } from "./emit/skills.ts";

export default function emit(ctx: EmitContext): void {
  const shellContext: EmitContext = {
    ...ctx,
    substituteToken: (source) => substituteLauncherInvocation(ctx, source),
  };
  const emissions = [
    ...collectLauncherEmissions(shellContext),
    ...collectSkillEmissions(shellContext),
    ...collectHookEmissions(shellContext),
    ...collectAppEmissions(shellContext),
  ].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

  /** Read collector paths before deletion or writing. Require canonical relative
   * POSIX file paths and reject duplicate or file/directory collisions before
   * mutation. Always on, with no bypass; protects packager-owned siblings,
   * not hostile repository code. */
  const paths = new Set<string>();
  for (const { path } of emissions) {
    const parts = path.split("/");
    if (path.includes("\\") || path.includes(":") || path.includes("\0") ||
      parts.some((part) => !part || part === "." || part === "..") || paths.has(path)) {
      throw new Error(`kiro-crew emission has an invalid or duplicate path: ${path}`);
    }
    paths.add(path);
  }
  for (const path of paths) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) {
      if (paths.has(parts.slice(0, i).join("/"))) {
        throw new Error(`kiro-crew emission has a file/directory collision: ${path}`);
      }
    }
  }

  const root = join(ctx.distRoot, "kiro-crew-app");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  for (const { path, content, mode = 0o644 } of emissions) {
    const destination = join(root, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, `${content.replace(/\r\n?/g, "\n").replace(/\n*$/, "")}\n`, "utf-8");
    chmodSync(destination, mode);
  }
}
