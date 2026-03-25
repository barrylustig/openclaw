import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  DEFAULT_SEARCH_COUNT,
  normalizeCacheKey,
  readCache,
  readResponseText,
  resolveCacheTtlMs,
  resolveSearchCount,
  resolveSiteName,
  resolveTimeoutSeconds,
  withTrustedWebSearchEndpoint,
  wrapWebContent,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import {
  resolveKagiCookieFile,
  resolveKagiEndpointUrlTemplate,
  resolveKagiUserAgent,
} from "./config.js";

const DEFAULT_TIMEOUT_SECONDS = 20;
const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";

const KAGI_SEARCH_CACHE = new Map<
  string,
  { value: Record<string, unknown>; insertedAt: number; expiresAt: number }
>();

type SearchResult = {
  title: string;
  url: string;
  snippet: string;
};

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/g, "/")
    .replace(/&nbsp;/g, " ")
    .replace(/&ndash;/g, "-")
    .replace(/&mdash;/g, "--")
    .replace(/&hellip;/g, "...")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchUrl(template: string, query: string): string {
  const resolved = template.includes("%s")
    ? template.replaceAll("%s", encodeURIComponent(query))
    : (() => {
        const url = new URL(template);
        url.searchParams.set("q", query);
        return url.toString();
      })();

  const url = new URL(resolved);
  if (url.hostname === "kagi.com" || url.hostname.endsWith(".kagi.com")) {
    if (url.pathname === "/search") {
      url.pathname = "/html/search";
    } else if (url.pathname === "/") {
      url.pathname = "/html/search";
    }
  }
  return url.toString();
}

function isKagiBotChallenge(html: string): boolean {
  return /Verifying you(?:’|')re human|cf-turnstile|turnstile_page|search-hero_cloud|doggo-spin/i.test(
    html,
  );
}

function readHrefAttribute(tagAttributes: string): string {
  return /\bhref="([^"]*)"/i.exec(tagAttributes)?.[1] ?? "";
}

function resolveCookieFilePath(rawPath: string | undefined): string | undefined {
  if (!rawPath) {
    return undefined;
  }
  if (rawPath.startsWith("~/")) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return rawPath;
}

function buildCookieHeaderFromFile(cookieFilePath: string | undefined): string | undefined {
  const resolvedPath = resolveCookieFilePath(cookieFilePath);
  if (!resolvedPath) {
    return undefined;
  }
  let text = "";
  try {
    text = fs.readFileSync(resolvedPath, "utf8");
  } catch {
    return undefined;
  }

  const pairs: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const parts = line.split("\t");
    if (parts.length >= 2) {
      const name = parts[0]?.trim();
      const value = parts[1]?.trim();
      if (name && value) {
        pairs.push(`${name}=${value}`);
      }
      continue;
    }
    if (line.includes("=")) {
      pairs.push(line.replace(/^Cookie:\s*/i, ""));
    }
  }

  return pairs.length > 0 ? pairs.join("; ") : undefined;
}

function extractSnippet(block: string): string {
  const snippetPatterns = [
    /<div\b[^>]*class="[^"]*__sri-desc[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<div\b[^>]*class="[^"]*_0_DESC[^"]*"[^>]*>([\s\S]*?)<\/div>/i,
    /<p\b[^>]*>([\s\S]*?)<\/p>/i,
  ];
  for (const pattern of snippetPatterns) {
    const match = pattern.exec(block);
    if (match) {
      const text = decodeHtmlEntities(stripHtml(match[1] ?? ""));
      if (text) {
        return text;
      }
    }
  }
  return "";
}

function parseKagiHtml(html: string): SearchResult[] {
  const results: SearchResult[] = [];

  for (const match of html.matchAll(
    /<div\b[^>]*class="[^"]*_0_SRI[^"]*search-result[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*(?:<div class="sr-group">|<div class="sri-group"|$)/gi,
  )) {
    const block = match[1] ?? "";
    const titleMatch =
      /<a\b[^>]*class="[^"]*__sri_title_link[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(
        block,
      );
    if (!titleMatch) {
      continue;
    }
    const url = decodeHtmlEntities(titleMatch[1] ?? "");
    const title = decodeHtmlEntities(stripHtml(titleMatch[2] ?? ""));
    if (!url || !title) {
      continue;
    }
    results.push({ title, url, snippet: extractSnippet(block) });
  }

  for (const match of html.matchAll(
    /<div\b[^>]*class="[^"]*__srgi[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi,
  )) {
    const block = match[1] ?? "";
    const titleMatch = /<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!titleMatch) {
      continue;
    }
    const url = decodeHtmlEntities(titleMatch[1] ?? "");
    const title = decodeHtmlEntities(stripHtml(titleMatch[2] ?? ""));
    if (!url || !title || !/^https?:\/\//i.test(url)) {
      continue;
    }
    results.push({ title, url, snippet: extractSnippet(block) });
  }

  if (results.length > 0) {
    return results;
  }

  const genericLinkRegex = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of html.matchAll(genericLinkRegex)) {
    const attrs = match[1] ?? "";
    const href = decodeHtmlEntities(readHrefAttribute(attrs));
    const title = decodeHtmlEntities(stripHtml(match[2] ?? ""));
    if (!href || !title) {
      continue;
    }
    if (!/^https?:\/\//i.test(href)) {
      continue;
    }
    if (/kagi\.com\//i.test(href) || /web\.archive\.org\//i.test(href)) {
      continue;
    }
    if (title.length < 8) {
      continue;
    }
    results.push({ title, url: href, snippet: "" });
    if (results.length >= 10) {
      break;
    }
  }

  return results;
}

export async function runKagiSearch(params: {
  config?: OpenClawConfig;
  query: string;
  count?: number;
  timeoutSeconds?: number;
  cacheTtlMinutes?: number;
}): Promise<Record<string, unknown>> {
  const endpointUrlTemplate = resolveKagiEndpointUrlTemplate(params.config);
  if (!endpointUrlTemplate) {
    throw new Error(
      "Kagi search is not configured. Set plugins.entries.kagi.config.webSearch.endpointUrlTemplate.",
    );
  }

  const count = resolveSearchCount(params.count, DEFAULT_SEARCH_COUNT);
  const timeoutSeconds = resolveTimeoutSeconds(params.timeoutSeconds, DEFAULT_TIMEOUT_SECONDS);
  const cacheTtlMs = resolveCacheTtlMs(params.cacheTtlMinutes, DEFAULT_CACHE_TTL_MINUTES);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "kagi",
      query: params.query,
      count,
      endpointUrlTemplate,
    }),
  );
  const cached = readCache(KAGI_SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const url = buildSearchUrl(endpointUrlTemplate, params.query);
  const userAgent = resolveKagiUserAgent(params.config) ?? DEFAULT_USER_AGENT;
  const cookieHeader = buildCookieHeaderFromFile(resolveKagiCookieFile(params.config));
  const startedAt = Date.now();
  const results = await withTrustedWebSearchEndpoint(
    {
      url,
      timeoutSeconds,
      init: {
        method: "GET",
        headers: {
          "User-Agent": userAgent,
          ...(cookieHeader ? { Cookie: cookieHeader } : {}),
        },
      },
    },
    async (response) => {
      if (!response.ok) {
        const detail = (await readResponseText(response, { maxBytes: 64_000 })).text;
        throw new Error(`Kagi search error (${response.status}): ${detail || response.statusText}`);
      }

      const html = await response.text();
      if (isKagiBotChallenge(html)) {
        throw new Error(
          "Kagi returned a human-verification challenge page instead of search results.",
        );
      }
      return parseKagiHtml(html).slice(0, count);
    },
  );

  const payload = {
    query: params.query,
    provider: "kagi",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "kagi",
      wrapped: true,
    },
    results: results.map((result) => ({
      title: wrapWebContent(result.title, "web_search"),
      url: result.url,
      snippet: result.snippet ? wrapWebContent(result.snippet, "web_search") : "",
      siteName: resolveSiteName(result.url) || undefined,
    })),
  } satisfies Record<string, unknown>;

  writeCache(KAGI_SEARCH_CACHE, cacheKey, payload, cacheTtlMs);
  return payload;
}
