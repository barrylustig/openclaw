import { Type } from "@sinclair/typebox";
import {
  enablePluginInConfig,
  resolveProviderWebSearchPluginConfig,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";
import { createBraveWebSearchProvider } from "../../brave/src/brave-web-search-provider.js";
import { createDuckDuckGoWebSearchProvider } from "../../duckduckgo/src/ddg-search-provider.js";
import { runKagiSearch } from "./kagi-client.js";

const KagiSearchSchema = Type.Object(
  {
    query: Type.String({ description: "Search query string." }),
    count: Type.Optional(
      Type.Number({
        description: "Number of results to return (1-10).",
        minimum: 1,
        maximum: 10,
      }),
    ),
  },
  { additionalProperties: false },
);

export function createKagiWebSearchProvider(): WebSearchProviderPlugin {
  return {
    id: "kagi",
    label: "Kagi Search",
    hint: "Kagi web search via configurable search URL template",
    requiresCredential: false,
    envVars: [],
    placeholder: "https://kagi.com/search?...&q=%s",
    signupUrl: "https://kagi.com/",
    docsUrl: "https://kagi.com/",
    autoDetectOrder: 95,
    credentialPath: "",
    inactiveSecretPaths: [],
    getCredentialValue: () => undefined,
    setCredentialValue: () => {},
    getConfiguredCredentialValue: (config) =>
      resolveProviderWebSearchPluginConfig(config, "kagi")?.endpointUrlTemplate,
    applySelectionConfig: (config) => enablePluginInConfig(config, "kagi").config,
    createTool: (ctx) => {
      const braveTool = createBraveWebSearchProvider().createTool(ctx);
      const duckTool = createDuckDuckGoWebSearchProvider().createTool(ctx);
      return {
        description:
          "Search the web using Kagi. Falls back to Brave and then DuckDuckGo when Kagi is unavailable.",
        parameters: KagiSearchSchema,
        execute: async (args) => {
          const query = typeof args.query === "string" ? args.query : "";
          const count = typeof args.count === "number" ? args.count : undefined;

          try {
            return await runKagiSearch({
              config: ctx.config,
              query,
              count,
            });
          } catch (kagiError) {
            if (braveTool) {
              try {
                const result = await braveTool.execute({ query, count });
                if (!(result && typeof result === "object" && "error" in result)) {
                  return {
                    ...result,
                    fallbackFrom: "kagi",
                    fallbackProvider: "brave",
                  };
                }
              } catch {
                // continue to duckduckgo fallback
              }
            }
            if (duckTool) {
              const result = await duckTool.execute({ query, count });
              return {
                ...result,
                fallbackFrom: "kagi",
                fallbackProvider: "duckduckgo",
              };
            }
            throw kagiError;
          }
        },
      };
    },
  };
}
