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
import { saveRoleModel } from "../config/load.ts";
import { decisionClassifier, decisionModels } from "./decision-provider.ts";
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

function roleAuthentication(
  role: Role,
  catalog: readonly RoleModel[],
  config: RoleConfig,
): ApiKeyAuth {
  return {
    name: `${role} OpenRouter API key`,

    async login(interaction) {
      const model = await interaction.prompt({
        type: "select",
        message: `Choose the ${role} model`,
        options: catalog.map(({ id }) => ({ id, label: id })),
        signal: interaction.signal,
      });
      if (!catalog.some(({ id }) => id === model)) {
        throw new Error(`Unknown ${role} model: ${model}`);
      }
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

      await saveRoleModel(role, model);
      config[role].model = model;
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

function createRoleProvider(upstream: Provider, role: Role, config: RoleConfig): Provider {
  const catalog = role === "decision" ? decisionModels(upstream) : upstream.getModels();
  const selected = () =>
    catalog
      .filter((item) => item.id === config[role].model)
      .map((item) => ({ ...item, provider: role }));
  const classifyDecision = decisionClassifier(upstream);

  return {
    ...upstream,
    id: role,
    name: `${role} (OpenRouter)`,
    auth: { apiKey: roleAuthentication(role, catalog, config) },
    getModels: () => selected().filter((item) => item.type !== "classifier"),
    getAllModels: selected,
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

export function registerRoleProviders(pi: ExtensionAPI, config: RoleConfig): void {
  const upstream = builtinProviders().find((provider) => provider.id === "openrouter");
  if (!upstream) {
    throw new Error("Pi's OpenRouter provider is unavailable");
  }

  for (const role of ["worker", "decision", "summarizer"] as const) {
    pi.registerProvider(createRoleProvider(upstream, role, config));
  }
}
