import z from "@deepseek-ai/schemastery";
import { Context } from "@deepseek-ai/cordis";

//#region src/index.d.ts
/** Deployment-owned cadence, resource limits, and agent selection. */
interface Config {
  intervalMs: number;
  toolCallThreshold: number;
  maxConcurrent: number;
  timeoutMs: number;
  maxResponseBytes: number;
  maxParseRetries: number;
  includeSubagents: boolean;
  onlyWhenVisible: boolean;
}
/** Validated defaults; the call threshold is exclusive. */
declare const Config: z<Config>;
/** Services whose lifetime owns the scheduler. Persistence is verified by awaited flushes. */
declare const inject: string[];
/**
 * Attach background checks to all live agents and unwind timers and calls on removal.
 * @param ctx - plugin-owned context.
 * @param config - validated configuration.
 */
declare function apply(ctx: Context, config: Config): void;
//#endregion
export { Config, apply, inject };
//# sourceMappingURL=index.d.ts.map