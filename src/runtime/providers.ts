import type {
  Api,
  ApiKeyAuth,
  ClassifierApi,
  ClassifierModel,
  Model,
  Provider,
  SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { RoleConfig } from "../config/load.ts";
import { decisionClassifier, decisionModel } from "./decision-provider.ts";
type Role = "worker" | "decision" | "summarizer";
type RoleModel = Model<Api> | ClassifierModel<ClassifierApi>;

const completionRequestSchema = z
  .object({ model: z.string(), messages: z.array(z.unknown()) })
  .catchall(z.unknown());

function openRouterDefaults(options: SimpleStreamOptions = {}): SimpleStreamOptions {
  if (
    options.maxTokens !== undefined ||
    options.samplingParams?.max_tokens !== undefined ||
    options.samplingParams?.max_completion_tokens !== undefined
  ) {
    return options;
  }

  return {
    ...options,
    async onPayload(payload, model) {
      const request = completionRequestSchema.parse(payload);
      delete request.max_tokens;
      delete request.max_completion_tokens;
      const replacement = await options.onPayload?.(request, model);
      return replacement === undefined ? request : replacement;
    },
  };
}

function roleAuthentication(role: Role): ApiKeyAuth {
  return {
    name: `${role} OpenRouter API key`,

    async login(interaction) {
      const value = await interaction.prompt({
        type: "secret",
        message: `OpenRouter API key for ${role}`,
        signal: interaction.signal,
      });
      interaction.signal.throwIfAborted();

      const key = value.trim();
      if (!key) {
        throw new Error("API key cannot be empty");
      }

      return { type: "api_key", key };
    },

    async resolve({ credential, signal }) {
      signal.throwIfAborted();
      if (!credential?.key) {
        return undefined;
      }

      return {
        auth: { apiKey: credential.key },
        source: `Stored ${role} API key`,
      };
    },
  };
}

function createRoleProvider(upstream: Provider, role: Role, sourceModel: RoleModel): Provider {
  const model = { ...sourceModel, provider: role };
  const classifyDecision = decisionClassifier(upstream);

  return {
    ...upstream,
    id: role,
    name: `${role} (OpenRouter)`,
    auth: { apiKey: roleAuthentication(role) },
    getModels: () => (model.type === "classifier" ? [] : [model]),
    getAllModels: () => [model],
    classify(model, context, options) {
      if (role === "decision" && model.api === "typesafe-system-one") {
        return classifyDecision(model, context, options);
      }
      if (!upstream.classify) {
        throw new Error(`Unsupported classifier API: ${model.api}`);
      }
      return upstream.classify(model, context, options);
    },
    streamSimple(model, context, options) {
      return upstream.streamSimple(
        model,
        context,
        role !== "decision" && model.api === "openai-completions"
          ? openRouterDefaults(options)
          : options,
      );
    },
  };
}

export function registerRoleProviders(pi: ExtensionAPI, config: RoleConfig): string | undefined {
  const upstream = builtinProviders().find((provider) => provider.id === "openrouter");
  if (!upstream) {
    throw new Error("Pi's OpenRouter provider is unavailable");
  }

  for (const role of ["worker", "summarizer"] as const) {
    const id = config[role].model;
    if (!id) {
      continue;
    }
    const model = upstream.getModels().find((item) => item.id === id);
    if (!model) {
      throw new Error(`Unknown OpenRouter ${role} model: ${id}. Check config.json and /reload.`);
    }
    pi.registerProvider(createRoleProvider(upstream, role, model));
  }
  if (!config.decision.model) {
    return undefined;
  }
  const classifier = decisionModel(upstream, config.decision.model);
  if (classifier) {
    pi.registerProvider(createRoleProvider(upstream, "decision", classifier));
    return undefined;
  }
  return `Decision classifier is absent from the local OpenRouter catalog: ${config.decision.model}. Optional guidance is unavailable; deterministic tools remain usable. No model was substituted.`;
}
