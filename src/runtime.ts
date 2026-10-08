/**
 * Session runtime plumbing — a trimmed-down version of pi's main() flow.
 * Reuses createAgentSessionServices / createAgentSessionFromServices /
 * createAgentSessionRuntime so /new, /resume, /fork all behave like pi's.
 */

import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	ProjectTrustStore,
	resolveCliModel,
	resolveModelScopeWithDiagnostics,
	SessionManager,
	SettingsManager,
	type AgentSessionRuntime,
	type AgentSessionRuntimeDiagnostic,
	type CreateAgentSessionRuntimeResult,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Model } from "@earendil-works/pi-ai";
import { isAbsolute, resolve } from "node:path";
import type { ButterOptions } from "./options.js";

export interface ButterRuntime {
	runtime: AgentSessionRuntime;
	diagnostics: AgentSessionRuntimeDiagnostic[];
	modelFallbackMessage?: string;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
}

function resolveLocalPath(cwd: string, p: string): string {
	return isAbsolute(p) ? p : resolve(cwd, p);
}

async function createSessionManager(opts: ButterOptions): Promise<SessionManager> {
	const { cwd, sessionDir } = opts;
	if (opts.noSession) return SessionManager.inMemory(cwd);
	if (typeof opts.resume === "string") {
		const resolved = opts.resume;
		// Accept file paths directly, otherwise treat as session id / prefix.
		const path = resolved.endsWith(".jsonl") || resolved.includes("/")
			? resolveLocalPath(cwd, resolved)
			: SessionManager.findById(cwd, resolved, sessionDir);
		if (!path) throw new Error(`No session found matching '${resolved}'`);
		return SessionManager.open(path, sessionDir);
	}
	if (opts.resume === true || opts.continueRecent) {
		return SessionManager.continueRecent(cwd, sessionDir);
	}
	return SessionManager.create(cwd, sessionDir);
}

export async function createRuntime(opts: ButterOptions): Promise<ButterRuntime> {
	const cwd = opts.cwd;
	const agentDir = opts.agentDir ?? getAgentDir();
	const sessionDir = opts.sessionDir;
	const sessionManager = await createSessionManager(opts);
	const startupSettings = SettingsManager.create(cwd, agentDir);
	const trustStore = new ProjectTrustStore(agentDir);
	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];

	const createRuntime = async ({
		cwd: sessionCwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}: {
		cwd: string;
		agentDir: string;
		sessionManager: SessionManager;
		sessionStartEvent?: unknown;
		projectTrustContext?: unknown;
	}): Promise<CreateAgentSessionRuntimeResult> => {
		const projectTrusted = opts.trust === true ? true : (trustStore.get(sessionCwd) === true);
		const services = await createAgentSessionServices({
			cwd: sessionCwd,
			agentDir,
			settingsManager: SettingsManager.create(sessionCwd, agentDir, { projectTrusted }),
			modelRuntimeSignal: AbortSignal.timeout(15_000),
			resourceLoaderOptions: {
				additionalExtensionPaths: opts.extensionPaths.map((p) => resolveLocalPath(cwd, p)),
				additionalSkillPaths: opts.skillPaths.map((p) => resolveLocalPath(cwd, p)),
				additionalPromptTemplatePaths: opts.promptTemplatePaths.map((p) => resolveLocalPath(cwd, p)),
				additionalThemePaths: opts.themePaths.map((p) => resolveLocalPath(cwd, p)),
				noExtensions: opts.noExtensions,
				noSkills: opts.noSkills,

				noThemes: false,
				noContextFiles: opts.noContextFiles,
				systemPrompt: opts.systemPrompt,
				appendSystemPrompt: opts.appendSystemPrompt ? [opts.appendSystemPrompt] : undefined,
			},
		});
		const { settingsManager, modelRuntime } = services;

		const modelPatterns = opts.models ?? settingsManager.getEnabledModels?.();
		const scopedModels = modelPatterns?.length
			? (await resolveModelScopeWithDiagnostics(modelPatterns, modelRuntime, { signal: AbortSignal.timeout(15_000) })).scopedModels
			: [];

		const hasExistingSession = sessionManager.buildSessionContext().messages.length > 0;

		let model: Model<any> | undefined;
		let thinkingLevel: ThinkingLevel | undefined;
		if (opts.model) {
			const resolved = resolveCliModel({
				cliProvider: opts.provider,
				cliModel: opts.model,
				cliThinking: opts.thinking as ThinkingLevel | undefined,
				modelRuntime,
			});
			if (resolved.warning) diagnostics.push({ type: "warning", message: resolved.warning });
			if (resolved.error) diagnostics.push({ type: "error", message: resolved.error });
			model = resolved.model;
			if (!opts.thinking && resolved.thinkingLevel) thinkingLevel = resolved.thinkingLevel;
		}
		if (!model && scopedModels.length > 0 && !hasExistingSession) {
			const savedProvider = settingsManager.getDefaultProvider();
			const savedModelId = settingsManager.getDefaultModel();
			const saved = savedProvider && savedModelId ? modelRuntime.getModel(savedProvider, savedModelId) : undefined;
			const inScope = saved ? scopedModels.find((sm: { model: { provider: string; id: string } }) => sm.model.provider === saved.provider && sm.model.id === saved.id) : undefined;
			model = (inScope ?? scopedModels[0]).model;
			if (!opts.thinking && (inScope ?? scopedModels[0]).thinkingLevel) {
				thinkingLevel = (inScope ?? scopedModels[0]).thinkingLevel;
			}
		}
		if (opts.thinking) thinkingLevel = opts.thinking as ThinkingLevel;

		const created = await createAgentSessionFromServices({
			services,
			sessionManager,
			sessionStartEvent: sessionStartEvent as never,
			model,
			thinkingLevel,
			scopedModels: scopedModels.map((sm: { model: Model<any>; thinkingLevel?: ThinkingLevel }) => ({ model: sm.model, thinkingLevel: sm.thinkingLevel })),
			tools: opts.tools,
			excludeTools: opts.excludeTools,
			noTools: opts.noTools ? "all" : undefined,
		});
		return { ...created, services, diagnostics: services.diagnostics };
	};

	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});

	return {
		runtime,
		diagnostics: [...runtime.diagnostics, ...diagnostics],
		modelFallbackMessage: runtime.modelFallbackMessage,
		sessionManager: runtime.session.sessionManager,
		settingsManager: startupSettings,
	};
}
