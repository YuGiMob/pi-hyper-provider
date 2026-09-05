import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";
import { hyperProviderDir } from "./hyper.js";
import type { WarningSink } from "./notify.js";

const HyperStatusItemsSchema = Type.Object(
	{
		teamName: Type.Optional(Type.Boolean()),
		hypercredits: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);
const HyperStatusItemsValidator = Compile(HyperStatusItemsSchema);

export type HyperStatusItems = Required<Static<typeof HyperStatusItemsSchema>>;

const HyperTransportSchema = Type.Union([
	Type.Literal("openai-completions"),
	Type.Literal("openai-responses"),
	Type.Literal("anthropic-messages"),
]);
const HyperTransportValidator = Compile(HyperTransportSchema);

export type HyperTransportSetting = Static<typeof HyperTransportSchema>;

export const HYPER_TRANSPORTS: readonly HyperTransportSetting[] = [
	"openai-completions",
	"openai-responses",
	"anthropic-messages",
];
export const DEFAULT_HYPER_TRANSPORT: HyperTransportSetting = "openai-completions";
const DEFAULT_STATUS_ITEMS: HyperStatusItems = {
	teamName: false,
	hypercredits: true,
};

function settingsPath(): string {
	return path.join(hyperProviderDir(), "settings.json");
}

function legacySettingsPath(): string {
	return path.join(getAgentDir(), "settings.json");
}

export function readHyperStatusItems(warn?: WarningSink): HyperStatusItems {
	const settings = readSettingsObject();
	const statusItems = property(settings, "statusItems");
	if (statusItems !== undefined) {
		return (
			parseHyperStatusItems(statusItems, "statusItems in hyper-provider/settings.json", warn) ??
			readLegacyHyperStatusItems(warn) ?? { ...DEFAULT_STATUS_ITEMS }
		);
	}

	return readLegacyHyperStatusItems(warn) ?? { ...DEFAULT_STATUS_ITEMS };
}

export function writeHyperStatusItems(statusItems: HyperStatusItems): void {
	const settings = readSettingsObject();
	settings.statusItems = statusItems;

	mkdirSync(hyperProviderDir(), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export function readHyperTransport(warn?: WarningSink): HyperTransportSetting {
	const settings = readSettingsObject();
	return (
		parseHyperTransport(property(settings, "transport"), "transport in hyper-provider/settings.json", warn) ??
		DEFAULT_HYPER_TRANSPORT
	);
}

export function writeHyperTransport(transport: HyperTransportSetting): void {
	const settings = readSettingsObject();
	settings.transport = transport;

	mkdirSync(hyperProviderDir(), { recursive: true });
	writeFileSync(settingsPath(), `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

export function defaultHyperTransport(): HyperTransportSetting {
	return DEFAULT_HYPER_TRANSPORT;
}

export function normalizeHyperTransportSetting(value: string): HyperTransportSetting | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "openai-completions" || normalized === "completions") return "openai-completions";
	if (normalized === "openai-responses" || normalized === "responses") return "openai-responses";
	if (normalized === "anthropic-messages" || normalized === "anthropic" || normalized === "messages")
		return "anthropic-messages";
	return undefined;
}

export function hyperTransportSummary(transport: HyperTransportSetting): string {
	return `transport=${transport}`;
}

export function migrateHyperSettings(warn?: WarningSink): void {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	if (!legacyHyper) return;

	const legacyStatusItems = parseHyperStatusItems(
		property(legacyHyper, "statusItems"),
		"hyper.statusItems in settings.json",
		warn,
	);
	const settings = readSettingsObject();
	const statusItems = property(settings, "statusItems");
	let hasUsableStatusItems =
		parseHyperStatusItems(statusItems, "statusItems in hyper-provider/settings.json", warn) !== undefined;

	if (statusItems === undefined && legacyStatusItems !== undefined) {
		settings.statusItems = legacyStatusItems;
		writeSettingsObject(settingsPath(), settings);
		hasUsableStatusItems = true;
	}
	if (!hasUsableStatusItems) return;

	removeLegacyHyperStatusItems();
}

export function defaultHyperStatusItems(): HyperStatusItems {
	return { ...DEFAULT_STATUS_ITEMS };
}

function readSettingsObject(filePath = settingsPath()): Record<string, unknown> {
	if (!existsSync(filePath)) return {};
	const payload = JSON.parse(readFileSync(filePath, "utf-8"));
	if (!isRecord(payload)) throw new Error(`${filePath} must contain a JSON object`);
	return payload;
}

function writeSettingsObject(filePath: string, settings: Record<string, unknown>): void {
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function removeLegacyHyperStatusItems(): void {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	if (!legacyHyper || property(legacyHyper, "statusItems") === undefined) return;

	delete legacyHyper.statusItems;
	if (Object.keys(legacyHyper).length === 0) {
		delete legacySettings.hyper;
	}
	writeSettingsObject(legacySettingsPath(), legacySettings);
}

function readLegacyHyperStatusItems(warn?: WarningSink): HyperStatusItems | undefined {
	const legacySettings = readSettingsObject(legacySettingsPath());
	const legacyHyper = propertyObject(legacySettings, "hyper");
	return legacyHyper
		? parseHyperStatusItems(property(legacyHyper, "statusItems"), "hyper.statusItems in settings.json", warn)
		: undefined;
}

function parseHyperStatusItems(value: unknown, source: string, warn?: WarningSink): HyperStatusItems | undefined {
	if (value === undefined) return undefined;
	if (!HyperStatusItemsValidator.Check(value)) {
		warn?.(`Ignoring invalid ${source}`);
		return undefined;
	}

	return {
		...DEFAULT_STATUS_ITEMS,
		...value,
	};
}

function parseHyperTransport(value: unknown, source: string, warn?: WarningSink): HyperTransportSetting | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string") {
		const normalized = normalizeHyperTransportSetting(value);
		if (normalized !== undefined) return normalized;
	}
	if (!HyperTransportValidator.Check(value)) {
		warn?.(`Ignoring invalid ${source}`);
		return undefined;
	}

	return value;
}

function property(source: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(source, key)?.value;
}

function propertyObject(source: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
	const value = property(source, key);
	return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
