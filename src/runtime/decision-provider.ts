import type { ClassifierApi, ClassifierModel, Provider } from "@earendil-works/pi-ai";
import { rememberCapturedUsage } from "../usage/observer.ts";
import { createUsageCapture } from "../usage/provider-usage.ts";

const additionalModel: ClassifierModel<ClassifierApi> = {
  type: "classifier",
  id: "liquid/d1.2-ultra",
  name: "LiquidAI: d1.2-ultra",
  api: "typesafe-system-one",
  provider: "openrouter",
  baseUrl: "https://openrouter.ai/api/v1",
  input: ["text", "image"],
  contextWindow: 65536,
  cost: { input: 0.042, output: 0, cacheRead: 0.042, cacheWrite: 0.042 },
  compat: { imageInput: "state-image-urls", sendImageOptInHeader: false },
};

export function decisionModel(upstream: Provider, id: string) {
  const catalogModel = upstream.getAllModels?.().find((model) => model.id === id);
  if (catalogModel?.type === "classifier") {
    return catalogModel;
  }
  return id === additionalModel.id ? structuredClone(additionalModel) : undefined;
}

export function decisionClassifier(upstream: Provider): NonNullable<Provider["classify"]> {
  return async (model, context, options) => {
    if (!upstream.classify) {
      throw new Error(`Unsupported classifier API: ${model.api}`);
    }
    const sdkEndpoint = new URL("systemone", `${model.baseUrl.replace(/\/+$/u, "")}/`).href;
    const endpoint = new URL("/api/alpha/decisions", model.baseUrl);
    const requestFetch = options?.fetch ?? globalThis.fetch;
    const capture = createUsageCapture();
    const result = await upstream.classify(model, context, {
      ...options,
      async fetch(input, init) {
        const url = input instanceof Request ? input.url : String(input);
        let destination = input;
        if (url === sdkEndpoint) {
          destination = input instanceof Request ? new Request(endpoint, input) : endpoint;
        }
        const response = await requestFetch(destination, init);
        if (response.ok) {
          const body: unknown = await response
            .clone()
            .json()
            .catch(() => undefined);
          capture.observe(model.api, body);
        }
        return response;
      },
    });
    rememberCapturedUsage(result.usage, capture);
    return result;
  };
}
