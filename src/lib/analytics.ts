import packageJson from "../../package.json";

const POSTHOG_API_KEY = "phc_mpxTuPeojpQQFYsdBQjWBpnVxDXtk6YbVjnxFGwsrLnE";
const DEFAULT_POSTHOG_API_HOST = "https://eu.i.posthog.com";
const DISTINCT_ID_STORAGE_KEY = "bigecho.posthog.distinct_id";
const APP_VERSION = packageJson.version;

export type AnalyticsEventName =
  | "app_opened"
  | "rec_clicked"
  | "get_text_clicked"
  | "get_summary_clicked";

type AnalyticsPropertyValue = string | number | boolean | null;
type AnalyticsProperties = Record<string, AnalyticsPropertyValue | undefined>;

type PostHogCapturePayload = {
  api_key: string;
  distinct_id: string;
  event: AnalyticsEventName;
  properties: Record<string, AnalyticsPropertyValue | Record<string, AnalyticsPropertyValue>>;
  timestamp: string;
};

type AnalyticsTransport = (payload: PostHogCapturePayload) => Promise<void>;

let cachedDistinctId: string | null = null;
let initialized = false;
let contextProperties: AnalyticsProperties = {};
let transportOverride: AnalyticsTransport | null = null;
let captureEnabledOverride: boolean | null = null;

function posthogApiHost(): string {
  const configuredHost = import.meta.env.VITE_POSTHOG_API_HOST;
  const host = typeof configuredHost === "string" && configuredHost.trim() ? configuredHost : DEFAULT_POSTHOG_API_HOST;
  return host.replace(/\/+$/, "");
}

function posthogCaptureUrl(): string {
  return `${posthogApiHost()}/i/v0/e/`;
}

function safeLocalStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function createDistinctId(): string {
  const randomId =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `bigecho_${randomId}`;
}

export function getAnalyticsDistinctId(): string {
  if (cachedDistinctId) return cachedDistinctId;

  const storage = safeLocalStorage();
  const stored = storage?.getItem(DISTINCT_ID_STORAGE_KEY);
  if (stored) {
    cachedDistinctId = stored;
    return cachedDistinctId;
  }

  cachedDistinctId = createDistinctId();
  storage?.setItem(DISTINCT_ID_STORAGE_KEY, cachedDistinctId);
  return cachedDistinctId;
}

function getTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  } catch {
    return "unknown";
  }
}

function cleanProperties(properties: AnalyticsProperties): Record<string, AnalyticsPropertyValue> {
  return Object.fromEntries(
    Object.entries(properties).filter((entry): entry is [string, AnalyticsPropertyValue] => entry[1] !== undefined)
  );
}

function buildContextProperties(): Record<string, AnalyticsPropertyValue> {
  const location = typeof window !== "undefined" ? window.location : null;
  const screenInfo = typeof window !== "undefined" ? window.screen : null;

  return cleanProperties({
    app: "bigecho",
    app_version: APP_VERSION,
    app_runtime: "tauri",
    locale: typeof navigator !== "undefined" ? navigator.language : undefined,
    platform: typeof navigator !== "undefined" ? navigator.platform : undefined,
    timezone: getTimezone(),
    current_url: location?.href,
    host: location?.host,
    path: location?.pathname,
    screen_width: screenInfo?.width,
    screen_height: screenInfo?.height,
    ...contextProperties,
  });
}

function buildPersonProperties(): Record<string, AnalyticsPropertyValue> {
  const context = buildContextProperties();
  return {
    app: "bigecho",
    app_version: APP_VERSION,
    app_runtime: "tauri",
    locale: context.locale ?? null,
    platform: context.platform ?? null,
    timezone: context.timezone ?? null,
  };
}

function shouldCapture(): boolean {
  if (captureEnabledOverride !== null) return captureEnabledOverride;
  return Boolean(transportOverride) || import.meta.env.MODE !== "test";
}

async function defaultTransport(payload: PostHogCapturePayload): Promise<void> {
  if (typeof fetch !== "function") return;
  const response = await fetch(posthogCaptureUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`PostHog capture failed with ${response.status}${detail ? `: ${detail}` : ""}`);
  }
}

export async function captureAnalyticsEvent(
  event: AnalyticsEventName,
  properties: AnalyticsProperties = {}
): Promise<void> {
  if (!shouldCapture()) return;
  const distinctId = getAnalyticsDistinctId();

  const payload: PostHogCapturePayload = {
    api_key: POSTHOG_API_KEY,
    distinct_id: distinctId,
    event,
    timestamp: new Date().toISOString(),
    properties: {
      ...buildContextProperties(),
      distinct_id: distinctId,
      ...cleanProperties(properties),
      $set: buildPersonProperties(),
    },
  };

  try {
    await (transportOverride ?? defaultTransport)(payload);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[analytics] PostHog capture failed", error);
    }
    // Analytics must never block recording or session workflows.
  }
}

export function initializeAnalytics(context: AnalyticsProperties = {}): void {
  contextProperties = {
    ...contextProperties,
    ...context,
  };
  if (initialized) return;
  initialized = true;
  void captureAnalyticsEvent("app_opened");
}

export function setAnalyticsTransportForTests(transport: AnalyticsTransport | null): void {
  transportOverride = transport;
}

export function setAnalyticsEnabledForTests(enabled: boolean | null): void {
  captureEnabledOverride = enabled;
}

export function resetAnalyticsForTests(): void {
  cachedDistinctId = null;
  initialized = false;
  contextProperties = {};
  transportOverride = null;
  captureEnabledOverride = null;
}
