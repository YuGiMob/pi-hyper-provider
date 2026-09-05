import type { OpenAIResponsesOptions } from "@earendil-works/pi-ai";
import { openAIResponsesApi } from "@earendil-works/pi-ai/compat";

type ResponsesApi = ReturnType<typeof openAIResponsesApi>;
type OnPayload = NonNullable<OpenAIResponsesOptions["onPayload"]>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function withTypedInputItem(item: unknown): unknown {
	if (!isRecord(item) || item.type !== undefined || typeof item.role !== "string") return item;
	return { ...item, type: "message" };
}

function typeInputItems(payload: unknown): unknown {
	if (!isRecord(payload) || !Array.isArray(payload.input)) return payload;
	return { ...payload, input: payload.input.map(withTypedInputItem) };
}

function composeOnPayload(caller: OnPayload | undefined): OnPayload {
	return (payload, model) => {
		const patched = typeInputItems(payload);
		const result = caller?.(patched, model);
		return result === undefined ? patched : result;
	};
}

export function hyperResponsesApi(): ResponsesApi {
	const api = openAIResponsesApi();
	const wrap = <T extends { onPayload?: OnPayload }>(options: T | undefined): T =>
		({ ...(options ?? {}), onPayload: composeOnPayload(options?.onPayload) }) as T;
	return {
		...api,
		stream: (model, context, options) => api.stream(model, context, wrap(options)),
		streamSimple: (model, context, options) => api.streamSimple(model, context, wrap(options)),
	};
}
