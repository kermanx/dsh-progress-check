import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { SessionId, appendPluginRecord } from "@deepseek-ai/dsh-session";
import { LOCALE_SETTINGS_NAMESPACE } from "@deepseek-ai/dsh-client-locale";
import { clientRequestSchema, transportError } from "@deepseek-ai/dsh-client-connection";
//#region src/prompt.ts
/** Compact English progress instructions with turn-phase context and DSH language preference. */
const QUESTION = `Report progress from the conversation. Do not run tools, continue the task, ask externally, or invent plans; report only decided/active work or completed turn outcomes.

Return ONLY raw JSON (string arrays, no fences/extra text; [] is normal when empty):
{"progress":["{current work or turn outcome}","{optional immediate next step}"],"uncertainties":[],"userActions":[]}

- progress: 1–2 ultra-short telegraphic lines (<=15 words or ~25 CJK chars each; fill placeholders without braces). Line 1: active work or turn outcome. Line 2 (omit if done or small): immediate next step or pending follow-up only. Omit repetition, background, overall goal/request, reviewed material, and prior stages.
- uncertainties: only genuine confusion or very uncertain technical choices. Exclude self-verifiable facts (even unchecked), settled plans, routine work/verification, general risks, and invented or out-of-scope issues.
- userActions: only high-ROI actions the user can take now (in parallel while running, or follow-up decisions/inputs after turn end); do your own work.

Report actions/results, not reading or generic/mechanical steps. State final designs/architecture/approach without rationale or implementation details. Name files/symbols only for essential orientation; never list paths, identifiers, or code. Distinguish verified results from plans; invent no percentages or problems.

Use non-empty thinking to verify facts and every rule before outputting JSON; keep reasoning out of JSON.`;
const RETRY_INSTRUCTION = "The previous response could not be parsed. Follow all rules above.";
/**
* Build the logged query using the preference at the start of this attempt.
* @param locale - explicit DSH locale selection; absence preserves conversation-based language selection.
* @param retry - whether a prior response failed format validation.
* @param phase - whether the turn is still running or just ended.
* @returns the complete auxiliary user message, including its phase and output-language instruction.
*/
function createQuestion(locale, retry, phase = "running") {
	const state = phase === "turn-end" ? "Phase: turn ended — summarize what settled this turn; omit next step if complete." : "Phase: turn in progress — report current work and decided immediate next step.";
	const language = locale === void 0 ? "Use the user's language from the conversation." : `DSH output language is ${JSON.stringify(locale)} (BCP 47), overriding conversation/examples.`;
	return `<system>\n${QUESTION}\n\n${state}${retry ? `\n\n${RETRY_INSTRUCTION}` : ""}\n\n${language}\n</system>`;
}
//#endregion
//#region src/records.ts
/** Versioned, ignorable progress records; none are part of the model conversation. */
/** Persisted report text and lists consumed by existing cards. */
const reportSchema = z$1.object({
	progress: z$1.string().trim().min(1),
	uncertainties: z$1.array(z$1.string().trim().min(1)),
	userActions: z$1.array(z$1.string().trim().min(1))
}).strict();
/** Validate concise progress lines (1–2 lines) and join them for the durable report format. */
const modelReportSchema = reportSchema.extend({ progress: z$1.array(z$1.string().trim().min(1)).min(1).max(2).transform((lines) => lines.join("\n")) });
/** Latest session progress report projected to the client dock. */
const progressViewSchema = z$1.object({
	id: z$1.string().min(1),
	updatedAt: z$1.number().nonnegative(),
	stepsAgo: z$1.number().int().nonnegative(),
	needsRefresh: z$1.boolean(),
	report: reportSchema
}).nullable();
/** Validated persisted result fields consumed by the client and cadence projection. */
const resultSchema = z$1.object({
	version: z$1.literal(1),
	id: z$1.string().min(1),
	sessionId: z$1.string().min(1),
	coveredToolCount: z$1.number().int().nonnegative(),
	coveredStepCount: z$1.number().int().nonnegative().optional(),
	contextSeq: z$1.number().int().nonnegative(),
	report: reportSchema
});
/**
* Read an untrusted durable or wire record without importing the Host Session runtime.
* @param event - event envelope received from storage or history.
* @returns validated display data only for this plugin's successful records.
*/
function readResult(event) {
	if (event.type !== "plugin:progress-check/result" || event.ignorable !== true) return void 0;
	const parsed = resultSchema.safeParse(event.data);
	return parsed.success ? parsed.data : void 0;
}
//#endregion
//#region src/projection.ts
/** Host projection for completed steps, report watermarks, and the latest client card. */
const READ_ONLY_TOOLS = /* @__PURE__ */ new Set([
	"read",
	"grep",
	"glob",
	"read_image"
]);
const READ_ONLY_BASH_CMDS = /* @__PURE__ */ new Set([
	"cat",
	"ls",
	"head",
	"tail",
	"pwd",
	"which",
	"echo",
	"stat",
	"wc",
	"file",
	"tree"
]);
/** Whether a tool call performs work beyond obvious read-only inspection. */
function isActionToolCall(name, argsJson) {
	if (READ_ONLY_TOOLS.has(name)) return false;
	if (name === "bash" && typeof argsJson === "string") try {
		const parsed = JSON.parse(argsJson);
		if (typeof parsed.command === "string" && !/[><`$()]/.test(parsed.command)) {
			const segments = parsed.command.split(/&&|\|\||[;|]/).map((s) => s.trim()).filter(Boolean);
			if (segments.length > 0 && segments.every((seg) => {
				const tokens = seg.split(/\s+/).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token));
				return tokens.length > 0 && READ_ONLY_BASH_CMDS.has(tokens[0]);
			})) return false;
		}
	} catch {}
	return true;
}
const latestSchema = z$1.object({
	id: z$1.string().min(1),
	updatedAt: z$1.number().nonnegative(),
	stepsAgo: z$1.number().int().nonnegative(),
	needsRefresh: z$1.boolean(),
	report: reportSchema
});
/** Counts child-owned completed steps, tracks watermarks, and exposes only the latest report to the client. */
const progressProjection = {
	key: "progress-check",
	stateVersion: 7,
	stateSchema: z$1.object({
		sessionId: z$1.string(),
		inherited: z$1.number().int().nonnegative(),
		seq: z$1.number().int().nonnegative(),
		toolCount: z$1.number().int().nonnegative(),
		actionToolCount: z$1.number().int().nonnegative().default(0),
		stepCount: z$1.number().int().nonnegative(),
		covered: z$1.number().int().nonnegative(),
		coveredActionTools: z$1.number().int().nonnegative().default(0),
		latest: latestSchema.nullable().default(null)
	}),
	wire: {
		viewSchema: progressViewSchema,
		view: (state) => state.latest,
		summary: false
	},
	init: (header, inherited) => ({
		sessionId: header.id,
		inherited,
		seq: 0,
		toolCount: 0,
		actionToolCount: 0,
		stepCount: 0,
		covered: 0,
		coveredActionTools: 0,
		latest: null
	}),
	apply: (state, event) => {
		if (event.seq < state.inherited) return state;
		const result = readResult(event);
		const mine = result?.sessionId === state.sessionId;
		const isTool = event.type === "tool/call";
		const isActionTool = isTool && isActionToolCall(event.data.name, event.data.arguments);
		const toolCount = state.toolCount + (isTool ? 1 : 0);
		const actionToolCount = state.actionToolCount + (isActionTool ? 1 : 0);
		const stepCount = state.stepCount + (event.type === "step/end" ? 1 : 0);
		const covered = mine ? Math.max(state.covered, Math.min(state.stepCount, result.coveredStepCount ?? state.stepCount)) : state.covered;
		const coveredActionTools = mine ? actionToolCount : state.coveredActionTools;
		const stepsAgo = Math.max(0, stepCount - covered);
		const needsRefresh = stepsAgo > 0 && actionToolCount > coveredActionTools;
		const latest = mine ? {
			id: result.id,
			updatedAt: event.time,
			stepsAgo,
			needsRefresh,
			report: result.report
		} : state.latest !== null && (event.type === "step/end" || isActionTool) ? {
			...state.latest,
			stepsAgo,
			needsRefresh
		} : state.latest;
		return {
			...state,
			seq: event.seq,
			toolCount,
			actionToolCount,
			stepCount,
			covered,
			coveredActionTools,
			latest
		};
	}
};
//#endregion
//#region src/protocol.ts
/** Validated messages on the plugin's authenticated Connection RPC channel. */
/** Connection owns authentication, correlation, transport, and cancellation. */
const PROGRESS_CHANNEL = "/api";
/** The sole generation operation on this channel. */
const GENERATE_METHOD = "progress-check/generate";
/** Untrusted browser input; only the target Session may be chosen. */
const generateRequestSchema = z$1.object({ sessionId: z$1.string().min(1) }).strict();
z$1.object({ seq: z$1.number().int().nonnegative() }).strict();
/** Visibility operation: which Sessions a browser page is actually showing. */
const PRESENCE_METHOD = "progress-check/presence";
/**
* One browser page's statement about what it is showing. The page owns the
* identity, so several tabs on different Sessions coexist in Host state.
*/
const presenceReportSchema = z$1.object({
	/** Stable for one page load. */
	clientId: z$1.string().min(1).max(128),
	/** Sessions this page currently shows in its main area. */
	sessionIds: z$1.array(z$1.string().min(1).max(256)).max(32),
	/** Whether the page is on screen: its tab is visible and its window focused. */
	visible: z$1.boolean()
}).strict();
//#endregion
//#region src/presence.ts
/**
* Latest report per browser page. A report carries no lifetime of its own:
* pages refresh it while they stay in the foreground, so a closed tab expires
* instead of leaving its Session "shown" forever.
*/
var PresenceRegistry = class {
	clients = /* @__PURE__ */ new Map();
	/**
	* Record one page's report, replacing that page's previous statement.
	* @param presence - validated report from the page's current state.
	* @param now - clock override for tests.
	*/
	report(presence, now = Date.now()) {
		this.clients.set(presence.clientId, {
			sessionIds: new Set(presence.sessionIds),
			visible: presence.visible,
			at: now
		});
	}
	/**
	* Whether any page still in the foreground shows this Session. Expiry is
	* evaluated on read, so a stale report stops counting even with no traffic.
	* @param sessionId - Session to test.
	* @param now - clock override for tests.
	* @returns true while at least one fresh, visible report names the Session.
	*/
	watched(sessionId, now = Date.now()) {
		let watched = false;
		for (const [clientId, state] of this.clients) {
			if (now - state.at > 15e3) {
				this.clients.delete(clientId);
				continue;
			}
			if (state.visible && state.sessionIds.has(sessionId)) watched = true;
		}
		return watched;
	}
	/** Forget every report; unload must not leave Host state behind. */
	clear() {
		this.clients.clear();
	}
};
//#endregion
//#region src/rpc.ts
/** Register owner-only routes without the dedicated channel's WebServer context lookup. */
function registerProgressRpc(ctx, handler) {
	for (const endpoint of [GENERATE_METHOD, PRESENCE_METHOD]) ctx.connection.fetch.register({
		path: `${PROGRESS_CHANNEL}/${endpoint}`,
		methods: ["POST"],
		requestBody: "buffered",
		fetch: async (request) => {
			if (request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") return new Response(null, { status: 415 });
			let body;
			try {
				body = await request.json();
			} catch {
				return new Response(null, { status: 400 });
			}
			const parsed = clientRequestSchema.safeParse(body);
			if (!parsed.success || parsed.data.method !== endpoint) return new Response(null, { status: 400 });
			const result = await handler(endpoint, parsed.data.payload, request.signal, ctx.connection.browserPeer).catch(transportError);
			return Response.json({
				type: "server-response",
				rpcId: parsed.data.rpcId,
				result
			});
		}
	});
}
//#endregion
//#region src/index.ts
/** Periodic auxiliary progress checks for running agents, with durable Session records. */
/** Validated defaults; both minimum intervals must be met for automatic checks. */
const Config = z.object({
	intervalMs: z.number().min(1).step(1).default(6e4).volatile(),
	intervalSteps: z.number().min(1).step(1).default(5).volatile(),
	maxConcurrent: z.number().min(1).step(1).default(1).volatile(),
	timeoutMs: z.number().min(1).step(1).default(12e4).volatile(),
	maxResponseBytes: z.number().min(1).step(1).default(262144).volatile(),
	maxParseRetries: z.number().min(0).max(3).step(1).default(3).volatile(),
	includeSubagents: z.boolean().default(false).volatile(),
	onlyWhenVisible: z.boolean().default(true).volatile(),
	refreshOnTurnEnd: z.boolean().default(false).volatile()
});
/** Services whose lifetime owns the scheduler. Persistence is verified by awaited flushes. */
const inject = [
	"agents",
	"sessions",
	"sessionProjections",
	"llm"
];
/**
* Attach background checks to all live agents and unwind timers and calls on removal.
* Awaits projection registration before exposing reads or operations that depend on it.
* @param ctx - plugin-owned context.
* @param config - validated configuration.
* @returns when the projection is registered and the schedulers are listening.
*/
async function apply(ctx, config) {
	const localeSettings = z$1.object({ preference: z$1.string().optional() });
	const outputLocale = () => {
		const descriptor = ctx.get("settings")?.describe().find((form) => form.ns === LOCALE_SETTINGS_NAMESPACE);
		return descriptor === void 0 ? void 0 : localeSettings.parse(descriptor.value).preference;
	};
	const work = /* @__PURE__ */ new Map();
	const presence = new PresenceRegistry();
	let stopped = false;
	let active = 0;
	const pending = /* @__PURE__ */ new Set();
	const projection = await ctx.sessionProjections.register(progressProjection);
	const stateOf = (agent) => projection.stateOf(agent.session);
	const alive = (entry) => !stopped && work.get(entry.agent.session.id) === entry;
	const running = (entry) => alive(entry) && entry.agent.status === "running";
	const eligible = (entry, reason) => reason === "periodic" ? running(entry) : alive(entry);
	const watched = (entry) => !config.onlyWhenVisible.get() || presence.watched(entry.agent.session.id);
	const stopTimer = (entry) => {
		if (entry.timer !== void 0) clearTimeout(entry.timer);
		entry.timer = void 0;
		if (entry.startedAt !== void 0) entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
		entry.startedAt = void 0;
	};
	const terminate = (entry) => {
		stopTimer(entry);
		entry.due = false;
		entry.turnEndDue = false;
		entry.operation?.controller.abort(/* @__PURE__ */ new Error("agent stopped working"));
		entry.snapshot = void 0;
	};
	const pause = (entry) => {
		stopTimer(entry);
		if (entry.operation?.reason === "periodic") entry.operation.controller.abort(/* @__PURE__ */ new Error("agent stopped working"));
		if (!entry.turnEndDue && entry.operation?.reason !== "turn-end" && entry.operation?.reason !== "manual") entry.snapshot = void 0;
	};
	const buildPostTurnRequest = (entry) => {
		const { session } = entry.agent;
		const messages = session.deriveMessages();
		if (messages.length === 0) return void 0;
		if (entry.template !== void 0) return {
			...structuredClone(entry.template),
			messages: structuredClone(messages),
			toolHistory: structuredClone(session.toolHistory())
		};
		const header = session.requestHeader();
		if (header === void 0) return void 0;
		return {
			...structuredClone(header.config),
			messages: structuredClone(messages),
			toolHistory: structuredClone(session.toolHistory()),
			...header.tools !== void 0 ? { tools: structuredClone(header.tools) } : {},
			sessionId: session.id
		};
	};
	const arm = (entry) => {
		if (!running(entry) || entry.timer !== void 0 || entry.due || entry.operation !== void 0) return;
		entry.startedAt = performance.now();
		entry.timer = setTimeout(() => {
			entry.timer = void 0;
			entry.startedAt = void 0;
			entry.remaining = 0;
			entry.due = true;
			pump();
		}, entry.remaining);
		entry.timer.unref?.();
	};
	const reset = (entry) => {
		entry.due = false;
		entry.remaining = config.intervalMs.get();
		arm(entry);
	};
	const attach = (agent) => {
		if (work.has(agent.session.id) || !config.includeSubagents.get() && agent.session.header.origin === "subagent") return;
		const state = stateOf(agent);
		const entry = {
			agent,
			remaining: config.intervalMs.get(),
			startedAt: void 0,
			timer: void 0,
			due: false,
			turnEndDue: false,
			template: void 0,
			snapshot: void 0,
			operation: void 0,
			covered: state.covered,
			coveredTools: state.coveredActionTools
		};
		work.set(agent.session.id, entry);
		arm(entry);
	};
	const flush = async (entry) => {
		if (!await ctx.sessions.flush(entry.agent.session)) throw new Error("progress-check requires durable session persistence");
	};
	const check = async (entry, snapshot, controller, reason) => {
		const id = randomUUID();
		const { session } = entry.agent;
		const abort = () => controller.abort(snapshot.signal?.reason);
		snapshot.signal?.addEventListener("abort", abort, { once: true });
		if (snapshot.signal?.aborted) abort();
		try {
			for (let attempt = 1;; attempt++) {
				const assembler = new BlockAssembler();
				const chunks = [];
				let finished = false;
				let bytes = 0;
				let truncated = false;
				let requestRecorded = false;
				let responseRecorded = false;
				let preparedConfig = false;
				let stage = "prepare";
				let request = {
					...snapshot.request,
					messages: [...snapshot.request.messages, {
						role: "user",
						content: [{
							type: "text",
							text: createQuestion(outputLocale(), attempt > 1, reason === "turn-end" ? "turn-end" : "running")
						}]
					}]
				};
				const recordRequest = () => {
					appendPluginRecord(session, "plugin:progress-check/request", {
						version: 1,
						id,
						attempt,
						prepared: preparedConfig,
						sessionId: session.id,
						coveredToolCount: snapshot.toolCount,
						coveredStepCount: snapshot.stepCount,
						contextSeq: snapshot.seq,
						request
					});
					requestRecorded = true;
				};
				const recordResponse = () => {
					let blocks = [];
					let assemblyError;
					try {
						blocks = assembler.blocks();
					} catch (error) {
						assemblyError = error instanceof Error ? error.message : String(error);
					}
					appendPluginRecord(session, "plugin:progress-check/response", {
						version: 1,
						id,
						attempt,
						sessionId: session.id,
						text: blocks.filter((block) => block.type === "text").map((block) => block.text).join(""),
						chunks,
						blocks,
						receivedBytes: bytes,
						truncated,
						...assemblyError === void 0 ? {} : { assemblyError },
						...finished ? { finish: assembler.finish } : {},
						...assembler.usage === void 0 ? {} : { usage: assembler.usage }
					});
					responseRecorded = true;
				};
				try {
					controller.signal.throwIfAborted();
					const prepared = await ctx.llm.prepareCall(request, controller.signal);
					request = {
						...request,
						...prepared.config
					};
					preparedConfig = true;
					controller.signal.throwIfAborted();
					stage = "request";
					recordRequest();
					await flush(entry);
					controller.signal.throwIfAborted();
					stage = "response";
					for await (const chunk of prepared.stream({
						...request,
						signal: controller.signal
					})) {
						controller.signal.throwIfAborted();
						bytes += Buffer.byteLength(JSON.stringify(chunk), "utf8");
						if (bytes > config.maxResponseBytes.get()) {
							truncated = true;
							throw new Error("progress-check response exceeded maxResponseBytes");
						}
						chunks.push(structuredClone(chunk));
						if (chunk.type === "tool-call-delta" || chunk.type === "block-start" && chunk.blockType === "tool-call" || chunk.type === "block-end" && chunk.block.type === "tool-call") throw new Error("progress-check model attempted a tool call");
						assembler.push(chunk);
						if (chunk.type === "finish") finished = true;
					}
					controller.signal.throwIfAborted();
					if (!eligible(entry, reason)) throw new Error("agent stopped working");
					if (!finished || assembler.finish.kind !== "stop") throw new Error(`progress-check did not finish normally (${assembler.finish.kind})`);
					stage = "persist";
					recordResponse();
					await flush(entry);
					controller.signal.throwIfAborted();
					const text = assembler.blocks().filter((block) => block.type === "text").map((block) => block.text).join("");
					stage = "parse";
					const report = modelReportSchema.parse(JSON.parse(text.replace(/^\s*```(?:json)?\s*\n/u, "").replace(/\n```\s*$/u, "")));
					stage = "persist";
					const seq = appendPluginRecord(session, "plugin:progress-check/result", {
						version: 1,
						id,
						attempt,
						sessionId: session.id,
						coveredToolCount: snapshot.toolCount,
						coveredStepCount: snapshot.stepCount,
						contextSeq: snapshot.seq,
						report,
						blocks: assembler.blocks(),
						...assembler.usage === void 0 ? {} : { usage: assembler.usage }
					});
					await flush(entry);
					entry.covered = snapshot.stepCount;
					entry.coveredTools = snapshot.actionToolCount;
					return {
						ok: true,
						seq
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const retryable = stage === "parse" && reason === "turn-end";
					if (ctx.sessions.get(session.id) !== session) return {
						ok: false,
						message
					};
					try {
						if (!requestRecorded) recordRequest();
						if (!responseRecorded) recordResponse();
						appendPluginRecord(session, "plugin:progress-check/failure", {
							version: 1,
							id,
							attempt,
							sessionId: session.id,
							stage,
							retryable,
							message,
							canceled: controller.signal.aborted,
							...error instanceof Error && error.stack !== void 0 ? { stack: error.stack } : {}
						});
						await flush(entry);
					} catch (persistError) {
						ctx.logger.warn(`progress-check ${id}: could not persist attempt ${attempt}: ${String(persistError)}`);
						return {
							ok: false,
							message
						};
					}
					if (!controller.signal.aborted) ctx.logger.warn(`progress-check ${id}, attempt ${attempt}, ${stage}: ${message}`);
					if (!retryable || attempt > config.maxParseRetries.get() || controller.signal.aborted || !eligible(entry, reason)) return {
						ok: false,
						message
					};
				}
			}
		} finally {
			snapshot.signal?.removeEventListener("abort", abort);
		}
	};
	const settle = (entry, operation, outcome) => {
		if (entry.operation !== operation) return;
		if (operation.phase === "running") active--;
		operation.cleanup();
		pending.delete(operation.promise);
		entry.operation = void 0;
		operation.resolve(outcome);
		reset(entry);
		pump();
	};
	const queue = (entry, reason, stepCount, signal) => {
		stopTimer(entry);
		entry.due = false;
		entry.turnEndDue = false;
		const controller = new AbortController();
		const completion = Promise.withResolvers();
		const timeout = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("progress-check timed out")), config.timeoutMs.get());
		timeout.unref?.();
		const abortCaller = () => controller.abort(signal?.reason);
		const abortQueued = () => {
			if (operation.phase === "queued") settle(entry, operation, {
				ok: false,
				message: controller.signal.reason instanceof Error ? controller.signal.reason.message : "progress-check canceled"
			});
		};
		const operation = {
			controller,
			phase: "queued",
			reason,
			stepCount,
			promise: completion.promise,
			resolve: completion.resolve,
			cleanup: () => {
				clearTimeout(timeout);
				signal?.removeEventListener("abort", abortCaller);
				controller.signal.removeEventListener("abort", abortQueued);
			}
		};
		entry.operation = operation;
		pending.add(operation.promise);
		controller.signal.addEventListener("abort", abortQueued, { once: true });
		signal?.addEventListener("abort", abortCaller, { once: true });
		if (signal?.aborted) abortCaller();
		return operation;
	};
	function pump() {
		if (stopped) return;
		for (const entry of work.values()) {
			if (!alive(entry) || entry.operation?.phase === "running") continue;
			const snapshot = entry.snapshot;
			if (snapshot === void 0) continue;
			let reason = entry.operation?.reason;
			if (entry.operation === void 0) if (entry.turnEndDue) {
				const state = stateOf(entry.agent);
				if (!config.refreshOnTurnEnd.get() || state.stepCount <= entry.covered || state.actionToolCount <= entry.coveredTools) {
					entry.turnEndDue = false;
					continue;
				}
				if (!watched(entry)) continue;
				reason = "turn-end";
			} else {
				if (!running(entry) || !entry.due) continue;
				if (snapshot.stepCount - entry.covered < config.intervalSteps.get()) continue;
				if (!watched(entry)) continue;
				reason = "periodic";
			}
			if (active >= config.maxConcurrent.get()) break;
			const operation = entry.operation ?? queue(entry, reason, snapshot.stepCount);
			operation.phase = "running";
			active++;
			Promise.resolve().then(() => check(entry, snapshot, operation.controller, operation.reason)).then((outcome) => settle(entry, operation, outcome), (error) => settle(entry, operation, {
				ok: false,
				message: String(error)
			}));
		}
	}
	let intervalMs = config.intervalMs.get();
	let includeSubagents = config.includeSubagents.get();
	ctx.on("loader/volatile-update", () => {
		const nextInterval = config.intervalMs.get();
		if (nextInterval !== intervalMs) {
			intervalMs = nextInterval;
			for (const entry of work.values()) {
				if (entry.operation !== void 0 || entry.due || entry.turnEndDue) continue;
				stopTimer(entry);
				entry.remaining = nextInterval;
				arm(entry);
			}
		}
		const nextInclude = config.includeSubagents.get();
		if (nextInclude !== includeSubagents) {
			includeSubagents = nextInclude;
			if (nextInclude) for (const agent of ctx.agents.list()) attach(agent);
			else for (const [id, entry] of work) {
				if (entry.agent.session.header.origin !== "subagent") continue;
				terminate(entry);
				work.delete(id);
			}
		}
		pump();
	});
	ctx.inject(["settings"], (scope) => {
		scope.effect(() => scope.settings.configure({ auto: false }, ctx.fiber), "progress-check: configuration page policy");
	});
	ctx.provide("progressCheck", {
		generate: (sessionId, signal) => {
			const entry = work.get(sessionId);
			if (entry === void 0 || !running(entry) && entry.operation === void 0) return Promise.resolve({
				ok: false,
				message: "progress-check requires a running session"
			});
			if (signal.aborted) return Promise.resolve({
				ok: false,
				message: "progress-check canceled"
			});
			const operation = entry.operation ?? queue(entry, "manual", entry.snapshot?.stepCount ?? stateOf(entry.agent).stepCount, signal);
			pump();
			return operation.promise;
		},
		reportPresence: (report) => {
			presence.report(report);
			pump();
		}
	});
	ctx.inject(["connection"], (scope) => {
		const invalid = () => ({
			ok: false,
			error: {
				code: "progress-check/invalid-request",
				message: "invalid progress-check request",
				details: {}
			}
		});
		registerProgressRpc(scope, async (endpoint, payload, signal) => {
			if (endpoint === "progress-check/presence") {
				const report = presenceReportSchema.safeParse(payload);
				if (!report.success) return invalid();
				ctx.progressCheck.reportPresence(report.data);
				return {
					ok: true,
					value: {}
				};
			}
			const request = generateRequestSchema.safeParse(payload);
			if (endpoint !== "progress-check/generate" || !request.success) return invalid();
			const outcome = await ctx.progressCheck.generate(SessionId(request.data.sessionId), signal);
			return outcome.ok ? {
				ok: true,
				value: { seq: outcome.seq }
			} : {
				ok: false,
				error: {
					code: "progress-check/failed",
					message: outcome.message,
					details: {}
				}
			};
		});
	});
	ctx.on("agent/created", ({ agent }) => {
		attach(agent);
	}, { global: true });
	ctx.on("agent/status", ({ agent, status }) => {
		attach(agent);
		const entry = work.get(agent.session.id);
		if (entry === void 0) return;
		if (status === "idle") pause(entry);
		else arm(entry);
	}, { global: true });
	ctx.on("agent/disposed", ({ agent }) => {
		const entry = work.get(agent.session.id);
		if (entry === void 0) return;
		terminate(entry);
		work.delete(agent.session.id);
	}, { global: true });
	ctx.on("session/event", (session, event) => {
		const entry = work.get(session.id);
		if (entry === void 0 || !alive(entry)) return;
		if ("surfaceOp" in event && event.surfaceOp !== void 0) {
			entry.turnEndDue = false;
			entry.snapshot = void 0;
		}
		if (event.type === "turn/end") {
			if (!config.refreshOnTurnEnd.get()) return;
			const state = stateOf(entry.agent);
			if (state.actionToolCount <= entry.coveredTools || state.stepCount <= entry.covered) return;
			if (entry.operation !== void 0 && entry.operation.stepCount >= state.stepCount) return;
			const request = buildPostTurnRequest(entry);
			if (request === void 0) return;
			entry.snapshot = {
				request,
				signal: void 0,
				toolCount: state.toolCount,
				actionToolCount: state.actionToolCount,
				stepCount: state.stepCount,
				seq: state.seq
			};
			entry.turnEndDue = true;
			if (entry.operation !== void 0 && entry.operation.stepCount < state.stepCount) entry.operation.controller.abort(/* @__PURE__ */ new Error("superseded by turn end"));
			pump();
		}
	}, { global: true });
	ctx.on("llm/stream", (options, next) => {
		if (isAgentLoopRequest(options) && options.sessionId !== void 0) {
			const entry = work.get(options.sessionId);
			if (entry !== void 0 && running(entry)) {
				const { signal, messages: _messages, toolHistory: _toolHistory, ...template } = options;
				const state = stateOf(entry.agent);
				entry.template = structuredClone(template);
				entry.snapshot = {
					request: structuredClone({
						...template,
						messages: options.messages,
						...options.toolHistory === void 0 ? {} : { toolHistory: options.toolHistory }
					}),
					signal,
					toolCount: state.toolCount,
					actionToolCount: state.actionToolCount,
					stepCount: state.stepCount,
					seq: state.seq
				};
				pump();
			}
		}
		return next();
	}, {
		global: true,
		prepend: true
	});
	ctx.effect(() => () => {
		stopped = true;
		for (const entry of work.values()) terminate(entry);
		work.clear();
		presence.clear();
		return Promise.allSettled([...pending]).then(() => {});
	});
	for (const agent of ctx.agents.list()) attach(agent);
}
//#endregion
export { Config, apply, inject };

//# sourceMappingURL=index.js.map