import { createProvider, envApiKeyAuth, lazyOAuth, type OAuthAuth } from "@earendil-works/pi-ai";
import { anthropicMessagesApi, openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { CreditStatusRuntime } from "./credits.js";
import { HYPER_API_BASE_URL, type HyperApi, PROVIDER_DISPLAY_NAME, PROVIDER_NAME } from "./hyper.js";
import { createNotifier } from "./notify.js";
import { hyperResponsesApi } from "./responses.js";
import {
	defaultHyperTransport,
	type HyperTransportSetting,
	hyperTransportSummary,
	normalizeHyperTransportSetting,
	readHyperTransport,
	writeHyperTransport,
} from "./settings.js";

type CreditStatusState =
	| { kind: "idle" }
	| { kind: "loading"; operation: Promise<CreditStatusRuntime> }
	| { kind: "ready"; runtime: CreditStatusRuntime }
	| { kind: "disposed" };

type PendingCreditStatusRefresh = {
	ctx: ExtensionContext;
	model: ExtensionContext["model"];
};

function hyperApiMap() {
	return {
		"openai-completions": openAICompletionsApi(),
		"openai-responses": hyperResponsesApi(),
		"anthropic-messages": anthropicMessagesApi(),
	};
}

function buildHyperAuth(displayName: string) {
	return {
		apiKey: envApiKeyAuth("Hyper API key", ["HYPER_API_KEY"]),
		oauth: lazyOAuth({
			name: displayName,
			load: async () => {
				const { loginHyper, refreshHyperToken } = await import("./oauth.js");
				return {
					name: displayName,
					login: loginHyper,
					refresh: refreshHyperToken,
					toAuth: async (credential) => ({ apiKey: credential.access }),
				} satisfies OAuthAuth;
			},
		}),
	};
}

function makeFetchModels(api: HyperApi, providerId: string) {
	return async ({
		credential,
		signal,
	}: {
		credential?: { type: string; access?: string; key?: string };
		signal: AbortSignal;
	}) => {
		const token = credential?.type === "oauth" ? credential.access : credential?.key;
		const { fetchHyperModels } = await import("./models.js");
		return fetchHyperModels({ signal, token, api, provider: providerId });
	};
}

function registerHyperProvider(pi: ExtensionAPI, transport: HyperTransportSetting): void {
	pi.registerProvider(
		createProvider({
			id: PROVIDER_NAME,
			name: PROVIDER_DISPLAY_NAME,
			baseUrl: HYPER_API_BASE_URL,
			auth: buildHyperAuth(PROVIDER_DISPLAY_NAME),
			models: [],
			fetchModels: makeFetchModels(transport, PROVIDER_NAME),
			api: hyperApiMap(),
		}),
	);
}

function clearHyperStatus(ctx: ExtensionContext): void {
	ctx.ui.setStatus(PROVIDER_NAME, undefined);
}

type TransportUpdate =
	| { kind: "changed"; message: string; transport: HyperTransportSetting }
	| { kind: "unchanged"; message: string }
	| { kind: "invalid"; message: string };

const TRANSPORT_USAGE = "Usage: /hyper-transport [openai-completions|openai-responses|anthropic-messages|reset]";

function updateHyperTransport(args: string, previous: HyperTransportSetting): TransportUpdate {
	const tokens = args.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 0) return { kind: "unchanged", message: hyperTransportSummary(previous) };
	if (tokens.length !== 1) return { kind: "invalid", message: TRANSPORT_USAGE };
	if (tokens[0] === "reset") {
		const transport = defaultHyperTransport();
		if (transport === previous)
			return { kind: "unchanged", message: `Hyper transport unchanged. ${hyperTransportSummary(transport)}` };
		return { kind: "changed", message: `Hyper transport reset. ${hyperTransportSummary(transport)}`, transport };
	}
	const transport = normalizeHyperTransportSetting(tokens[0] ?? "");
	if (transport === undefined) return { kind: "invalid", message: TRANSPORT_USAGE };
	if (transport === previous)
		return { kind: "unchanged", message: `Hyper transport unchanged. ${hyperTransportSummary(transport)}` };
	return { kind: "changed", message: `Hyper transport updated. ${hyperTransportSummary(transport)}`, transport };
}

function transportLabel(transport: HyperTransportSetting): string {
	if (transport === "openai-completions") return "OpenAI Completions";
	if (transport === "openai-responses") return "OpenAI Responses";
	return "Anthropic Messages";
}

function sameTransport(a: HyperTransportSetting, b: HyperTransportSetting): boolean {
	return a === b;
}

async function configureHyperTransport(
	ctx: ExtensionContext,
	initial: HyperTransportSetting,
	isDisposed: () => boolean,
): Promise<HyperTransportSetting | undefined> {
	let draft: HyperTransportSetting = initial;
	for (;;) {
		const completionsOption = `OpenAI Completions${draft === "openai-completions" ? " (selected)" : ""}`;
		const responsesOption = `OpenAI Responses${draft === "openai-responses" ? " (selected)" : ""}`;
		const anthropicOption = `Anthropic Messages${draft === "anthropic-messages" ? " (selected)" : ""}`;
		const resetOption = "Reset to defaults";
		const saveOption = "Save changes";
		const cancelOption = "Cancel";
		const choice = await ctx.ui.select("Hyper transport settings", [
			completionsOption,
			responsesOption,
			anthropicOption,
			resetOption,
			saveOption,
			cancelOption,
		]);
		if (isDisposed()) return undefined;
		if (choice === undefined || choice === cancelOption) {
			ctx.ui.notify("Hyper transport settings unchanged", "info");
			return undefined;
		}
		if (choice === completionsOption) {
			draft = "openai-completions";
			continue;
		}
		if (choice === responsesOption) {
			draft = "openai-responses";
			continue;
		}
		if (choice === anthropicOption) {
			draft = "anthropic-messages";
			continue;
		}
		if (choice === resetOption) {
			draft = defaultHyperTransport();
			continue;
		}
		if (choice === saveOption) {
			if (sameTransport(initial, draft)) {
				ctx.ui.notify(`Hyper transport unchanged. ${hyperTransportSummary(draft)}`, "info");
				return undefined;
			}
			const ok = await ctx.ui.confirm("Save Hyper transport settings?", hyperTransportSummary(draft));
			if (isDisposed()) return undefined;
			if (!ok) {
				ctx.ui.notify("Hyper transport settings unchanged", "info");
				return undefined;
			}
			if (isDisposed()) return undefined;
			return draft;
		}
	}
}

export default function (pi: ExtensionAPI) {
	const notifier = createNotifier();
	let creditStatusState: CreditStatusState = { kind: "idle" };
	let pendingCreditStatusRefresh: PendingCreditStatusRefresh | undefined;
	let creditStatusRefreshWork: ReturnType<typeof setImmediate> | undefined;

	function loadCreditStatus(): Promise<CreditStatusRuntime> {
		if (creditStatusState.kind === "ready") return Promise.resolve(creditStatusState.runtime);
		if (creditStatusState.kind === "loading") return creditStatusState.operation;
		if (creditStatusState.kind === "disposed") {
			return Promise.reject(new Error("Hyper status support was disposed"));
		}
		const operation = import("./credits.js").then(({ createCreditStatusRuntime }) => {
			const runtime = createCreditStatusRuntime(notifier.warn);
			if (creditStatusState.kind === "disposed") {
				runtime.dispose();
				return runtime;
			}
			creditStatusState = { kind: "ready", runtime };
			return runtime;
		});
		creditStatusState = { kind: "loading", operation };
		void operation.catch(() => {
			if (creditStatusState.kind === "loading" && creditStatusState.operation === operation) {
				creditStatusState = { kind: "idle" };
			}
		});
		return operation;
	}

	function schedulePendingCreditStatusRefresh(): void {
		if (!pendingCreditStatusRefresh || creditStatusRefreshWork !== undefined) return;
		const scheduled = setImmediate(() => {
			void loadCreditStatus()
				.then((runtime) => {
					if (creditStatusRefreshWork !== scheduled) return;
					const refresh = pendingCreditStatusRefresh;
					pendingCreditStatusRefresh = undefined;
					creditStatusRefreshWork = undefined;
					if (refresh) {
						void runtime.refresh(refresh.ctx, refresh.model).catch((error: unknown) => {
							if (creditStatusState.kind !== "disposed") {
								notifier.warn(`Unable to refresh Hyper status: ${String(error)}`);
							}
						});
					}
				})
				.catch((error: unknown) => {
					if (creditStatusRefreshWork === scheduled && creditStatusState.kind !== "disposed") {
						pendingCreditStatusRefresh = undefined;
						notifier.warn(`Unable to load Hyper status support: ${String(error)}`);
					}
				})
				.finally(() => {
					if (creditStatusRefreshWork !== scheduled) return;
					creditStatusRefreshWork = undefined;
					schedulePendingCreditStatusRefresh();
				});
		});
		creditStatusRefreshWork = scheduled;
	}

	function scheduleCreditStatusRefresh(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = { ctx, model };
		schedulePendingCreditStatusRefresh();
	}

	function deactivateCreditStatus(ctx: ExtensionContext, model: ExtensionContext["model"]): void {
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) {
			clearImmediate(creditStatusRefreshWork);
			creditStatusRefreshWork = undefined;
		}
		if (creditStatusState.kind === "ready") {
			void creditStatusState.runtime.refresh(ctx, model);
		}
		clearHyperStatus(ctx);
	}

	function currentTransport(): HyperTransportSetting {
		try {
			return readHyperTransport(notifier.warn);
		} catch {
			return defaultHyperTransport();
		}
	}

	function applyTransport(transport: HyperTransportSetting): void {
		try {
			writeHyperTransport(transport);
		} catch (error) {
			notifier.warn(`Unable to save Hyper transport: ${String(error)}`);
		}
		registerHyperProvider(pi, transport);
	}

	pi.on("session_start", (_event, ctx) => {
		notifier.activate(ctx);
		registerHyperProvider(pi, currentTransport());
		if (!ctx.hasUI) return;
		if (ctx.model?.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, ctx.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	registerHyperProvider(pi, currentTransport());

	pi.registerCommand("hyper-status", {
		description: "Configure the Charm Hyper footer status",
		handler: async (args, ctx) => {
			try {
				const runtime = await loadCreditStatus();
				if (creditStatusState.kind === "disposed") return;
				await runtime.handleCommand(args, ctx);
			} catch (error) {
				if (creditStatusState.kind === "disposed") return;
				ctx.ui.notify(`Unable to load Hyper status support: ${String(error)}`, "warning");
			}
		},
	});

	pi.registerCommand("hyper-transport", {
		description: "Configure which Charm Hyper API transport to use",
		handler: async (args, ctx) => {
			const isDisposed = () => creditStatusState.kind === "disposed";
			if (isDisposed()) return;
			const previous = currentTransport();
			if (!args.trim()) {
				if (!ctx.hasUI) {
					ctx.ui.notify(hyperTransportSummary(previous), "info");
					return;
				}
				const transport = await configureHyperTransport(ctx, previous, isDisposed);
				if (isDisposed()) return;
				if (transport) {
					applyTransport(transport);
					ctx.ui.notify(
						`Hyper transport updated. ${hyperTransportSummary(transport)} Now showing ${transportLabel(transport)} models. Re-select your model with /model.`,
						"info",
					);
				}
				return;
			}
			const result = updateHyperTransport(args, previous);
			if (isDisposed()) return;
			if (result.kind === "changed") {
				applyTransport(result.transport);
			}
			ctx.ui.notify(result.message, "info");
		},
	});

	pi.on("model_select", (event, ctx) => {
		if (!ctx.hasUI) return;
		if (event.model.provider !== PROVIDER_NAME) {
			deactivateCreditStatus(ctx, event.model);
			return;
		}
		scheduleCreditStatusRefresh(ctx, event.model);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (creditStatusState.kind === "disposed" || !ctx.hasUI || ctx.model?.provider !== PROVIDER_NAME) return;
		scheduleCreditStatusRefresh(ctx, ctx.model);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		pendingCreditStatusRefresh = undefined;
		if (creditStatusRefreshWork !== undefined) clearImmediate(creditStatusRefreshWork);
		creditStatusRefreshWork = undefined;
		if (creditStatusState.kind === "ready") creditStatusState.runtime.dispose();
		creditStatusState = { kind: "disposed" };
		if (ctx.hasUI) clearHyperStatus(ctx);
	});
}
