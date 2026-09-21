import type { EmitContext } from "../../../scripts/manifest-types.ts";

export type Emission = {
  /** Relative to kiro-crew-app/, never the project engine or state tree. */
  path: string;
  content: string;
  mode?: 0o755 | 0o644;
};

export type Collector = (ctx: EmitContext) => Emission[];
