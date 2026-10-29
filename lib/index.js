import { randomUUID } from "node:crypto";
import z from "@deepseek-ai/schemastery";
import { z as z$1 } from "zod";
import { BlockAssembler, isAgentLoopRequest } from "@deepseek-ai/dsh-llm";
import { SessionId, appendPluginRecord } from "@deepseek-ai/dsh-session";
import { LOCALE_SETTINGS_NAMESPACE } from "@deepseek-ai/dsh-client-locale";
import { clientRequestSchema, transportError } from "@deepseek-ai/dsh-client-connection";
//#region src/prompt.ts
/** English progress instructions with the current DSH language preference. */
const QUESTION = `Independently report progress from the full conversation while the main task continues. Do not execute the task, call tools, ask questions outside the report, or devise new plans; report only plans already decided and being carried out.

First verify facts and requirements in the thinking phase with non-empty reasoning; exclude reasoning from the final JSON.

Return only a valid JSON object with exactly "progress", "uncertainties", and "userActions", all arrays of strings. No extra text or code fences.

"progress" must follow this order:
- Large tasks: exactly three items: current subtask, current operation within it, previously decided next step.
- Small tasks: exactly two items: current progress, previously decided next step.

Fill and translate this template into the output language, replacing placeholders and removing braces. For small tasks, combine the first two sentences; fill the other arrays only as specified below:
{"progress":["Working on {subtask}.","Currently {operation}.","Next, {previously decided immediate next step}."],"uncertainties":[],"userActions":[]}

Each item contains one action in its assigned position, without repetition or added background. Directly name the current stage and operation; do not restate the task, user request, reviewed material, or earlier stages. Give only the previously decided immediate next action, without later steps.

Write one sentence per item/line: form a complete sentence, then shorten without losing meaning or readability. Report actions, not reading; omit mechanical, generic operations and unnecessary repetition of known information. State final designs, architectural changes, and the overall approach without rationale or implementation details. Use filenames or identifiers only for necessary orientation; do not list paths, identifiers, or code.

"uncertainties": only existing unresolved questions you are deeply confused about or technical decisions you are very unsure of. Exclude facts you can verify yourself, settled plans reframed as needing confirmation, invented concerns, ordinary pending work, routine verification, general risks, and out-of-scope matters. Use [] if none qualify.

"userActions": only actions the user can take in parallel now with very high return on effort toward completing the task. Do not delegate your own work. Put required user answers or operations in your formal reply instead. Use [] if none qualify.

Use the specified output language. Distinguish verified results from plans; invent no percentages or problems. Before output, check JSON syntax, item counts, one sentence per item, next step last, and eligibility of the other two arrays' contents. Empty arrays are normal.`;
const RETRY_INSTRUCTION = "The previous response could not be parsed. Rewrite strictly under the JSON requirements above: progress has two or three non-empty, single-sentence items, with the next step last; the other arrays are empty unless content qualifies. No extra fields, explanations, or code fences.";
/**
* Build the logged query using the preference at the start of this attempt.
* @param locale - explicit DSH locale selection; absence preserves conversation-based language selection.
* @param retry - whether a prior response failed format validation.
* @returns the complete auxiliary user message, including its output-language instruction.
*/
function createQuestion(locale, retry) {
	const language = locale === void 0 ? "Use the user's language from the conversation for JSON text." : `DSH output language is ${JSON.stringify(locale)} (BCP 47). Use it for JSON text, overriding the conversation and examples.`;
	return `<system>\n${QUESTION}${retry ? `\n\n${RETRY_INSTRUCTION}` : ""}\n\n${language} Keep field names unchanged.\n</system>`;
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
/** Validate model progress lines and join them for the existing durable report format. */
const modelReportSchema = reportSchema.extend({ progress: z$1.array(z$1.string().trim().min(1)).min(2).max(3).transform((lines) => lines.join("\n")) });
/** Validated persisted result fields consumed by the client and cadence projection. */
const resultSchema = z$1.object({
	version: z$1.literal(1),
	id: z$1.string().min(1),
	sessionId: z$1.string().min(1),
	coveredToolCount: z$1.number().int().nonnegative(),
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
/** Counts child-owned tool/call events, without counting retries or inherited calls. */
const progressProjection = {
	key: "progress-check",
	stateVersion: 1,
	stateSchema: z$1.object({
		sessionId: z$1.string(),
		inherited: z$1.number().int().nonnegative(),
		seq: z$1.number().int().nonnegative(),
		toolCount: z$1.number().int().nonnegative(),
		covered: z$1.number().int().nonnegative()
	}),
	init: (header, inherited) => ({
		sessionId: header.id,
		inherited,
		seq: 0,
		toolCount: 0,
		covered: 0
	}),
	apply: (state, event) => {
		if (event.seq < state.inherited) return state;
		const result = readResult(event);
		return {
			...state,
			seq: event.seq,
			toolCount: state.toolCount + (event.type === "tool/call" ? 1 : 0),
			covered: result?.sessionId === state.sessionId ? Math.max(state.covered, Math.min(state.toolCount, result.coveredToolCount)) : state.covered
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
/** Validated defaults; the call threshold is exclusive. */
const Config = z.object({
	intervalMs: z.number().min(1).step(1).default(6e4),
	toolCallThreshold: z.number().min(0).step(1).default(5),
	maxConcurrent: z.number().min(1).step(1).default(2),
	timeoutMs: z.number().min(1).step(1).default(12e4),
	maxResponseBytes: z.number().min(1).step(1).default(262144),
	maxParseRetries: z.number().min(0).max(3).step(1).default(3),
	includeSubagents: z.boolean().default(true),
	onlyWhenVisible: z.boolean().default(true)
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
	const running = (entry) => !stopped && work.get(entry.agent.session.id) === entry && entry.agent.status === "running";
	const watched = (entry) => !config.onlyWhenVisible || presence.watched(entry.agent.session.id);
	const stopTimer = (entry) => {
		if (entry.timer !== void 0) clearTimeout(entry.timer);
		entry.timer = void 0;
		if (entry.startedAt !== void 0) entry.remaining = Math.max(0, entry.remaining - (performance.now() - entry.startedAt));
		entry.startedAt = void 0;
	};
	const pause = (entry) => {
		stopTimer(entry);
		entry.operation?.controller.abort(/* @__PURE__ */ new Error("agent stopped working"));
		entry.snapshot = void 0;
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
		entry.remaining = config.intervalMs;
		arm(entry);
	};
	const attach = (agent) => {
		if (work.has(agent.session.id) || !config.includeSubagents && agent.session.header.origin === "subagent") return;
		const state = stateOf(agent);
		const entry = {
			agent,
			remaining: config.intervalMs,
			startedAt: void 0,
			timer: void 0,
			due: false,
			snapshot: void 0,
			operation: void 0,
			covered: state.covered
		};
		work.set(agent.session.id, entry);
		arm(entry);
	};
	const flush = async (entry) => {
		if (!await ctx.sessions.flush(entry.agent.session)) throw new Error("progress-check requires durable session persistence");
	};
	const check = async (entry, snapshot, controller) => {
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
							text: createQuestion(outputLocale(), attempt > 1)
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
						if (bytes > config.maxResponseBytes) {
							truncated = true;
							throw new Error("progress-check response exceeded maxResponseBytes");
						}
						chunks.push(structuredClone(chunk));
						if (chunk.type === "tool-call-delta" || chunk.type === "block-start" && chunk.blockType === "tool-call" || chunk.type === "block-end" && chunk.block.type === "tool-call") throw new Error("progress-check model attempted a tool call");
						assembler.push(chunk);
						if (chunk.type === "finish") finished = true;
					}
					controller.signal.throwIfAborted();
					if (!running(entry)) throw new Error("agent stopped working");
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
						contextSeq: snapshot.seq,
						report,
						blocks: assembler.blocks(),
						...assembler.usage === void 0 ? {} : { usage: assembler.usage }
					});
					await flush(entry);
					entry.covered = snapshot.toolCount;
					return {
						ok: true,
						seq
					};
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					const retryable = stage === "parse";
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
					if (!retryable || attempt > config.maxParseRetries || controller.signal.aborted || !running(entry)) return {
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
	const queue = (entry, signal) => {
		stopTimer(entry);
		entry.due = false;
		const controller = new AbortController();
		const completion = Promise.withResolvers();
		const timeout = setTimeout(() => controller.abort(/* @__PURE__ */ new Error("progress-check timed out")), config.timeoutMs);
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
			if (!running(entry) || entry.operation?.phase === "running") continue;
			if (entry.operation === void 0 && !entry.due) continue;
			const snapshot = entry.snapshot;
			if (snapshot === void 0) continue;
			if (entry.operation === void 0) {
				if (snapshot.toolCount - entry.covered <= config.toolCallThreshold) {
					reset(entry);
					continue;
				}
				if (!watched(entry)) continue;
			}
			if (active >= config.maxConcurrent) break;
			const operation = entry.operation ?? queue(entry);
			operation.phase = "running";
			active++;
			Promise.resolve().then(() => check(entry, snapshot, operation.controller)).then((outcome) => settle(entry, operation, outcome), (error) => settle(entry, operation, {
				ok: false,
				message: String(error)
			}));
		}
	}
	ctx.provide("progressCheck", {
		generate: (sessionId, signal) => {
			const entry = work.get(sessionId);
			if (entry === void 0 || !running(entry)) return Promise.resolve({
				ok: false,
				message: "progress-check requires a running session"
			});
			if (signal.aborted) return Promise.resolve({
				ok: false,
				message: "progress-check canceled"
			});
			const operation = entry.operation ?? queue(entry, signal);
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
		pause(entry);
		work.delete(agent.session.id);
	}, { global: true });
	ctx.on("session/event", (session, event) => {
		const entry = work.get(session.id);
		if (entry !== void 0 && "surfaceOp" in event && event.surfaceOp !== void 0) entry.snapshot = void 0;
	}, { global: true });
	ctx.on("llm/stream", (options, next) => {
		if (isAgentLoopRequest(options) && options.sessionId !== void 0) {
			const entry = work.get(options.sessionId);
			if (entry !== void 0 && running(entry)) {
				const { signal, ...request } = options;
				const state = stateOf(entry.agent);
				entry.snapshot = {
					request: structuredClone(request),
					signal,
					toolCount: state.toolCount,
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
		for (const entry of work.values()) pause(entry);
		work.clear();
		presence.clear();
		return Promise.allSettled([...pending]).then(() => {});
	});
	for (const agent of ctx.agents.list()) attach(agent);
}
//#endregion
export { Config, apply, inject };

//# sourceMappingURL=index.js.map