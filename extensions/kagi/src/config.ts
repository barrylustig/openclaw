import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

type KagiPluginConfig = {
  webSearch?: {
    endpointUrlTemplate?: string;
    userAgent?: string;
    cookieFile?: string;
  };
};

export function resolveKagiWebSearchConfig(
  config?: OpenClawConfig,
): KagiPluginConfig["webSearch"] | undefined {
  const pluginConfig = config?.plugins?.entries?.kagi?.config as KagiPluginConfig | undefined;
  const webSearch = pluginConfig?.webSearch;
  if (webSearch && typeof webSearch === "object" && !Array.isArray(webSearch)) {
    return webSearch;
  }
  return undefined;
}

export function resolveKagiEndpointUrlTemplate(config?: OpenClawConfig): string | undefined {
  const value = resolveKagiWebSearchConfig(config)?.endpointUrlTemplate;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveKagiUserAgent(config?: OpenClawConfig): string | undefined {
  const value = resolveKagiWebSearchConfig(config)?.userAgent;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function resolveKagiCookieFile(config?: OpenClawConfig): string | undefined {
  const value = resolveKagiWebSearchConfig(config)?.cookieFile;
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}
