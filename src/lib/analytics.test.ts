import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  captureAnalyticsEvent,
  getAnalyticsDistinctId,
  resetAnalyticsForTests,
  setAnalyticsEnabledForTests,
  setAnalyticsTransportForTests,
} from "./analytics";

describe("analytics", () => {
  beforeEach(() => {
    localStorage.clear();
    resetAnalyticsForTests();
  });

  it("sends PostHog events with a persistent distinct user id and app context", async () => {
    const transport = vi.fn(async () => undefined);
    setAnalyticsTransportForTests(transport);

    await captureAnalyticsEvent("get_text_clicked", {
      session_id: "s1",
      surface: "sessions",
    });

    const distinctId = getAnalyticsDistinctId();
    expect(distinctId).toMatch(/^bigecho_/);
    expect(getAnalyticsDistinctId()).toBe(distinctId);
    expect(transport).toHaveBeenCalledWith(
      expect.objectContaining({
        api_key: "phc_mpxTuPeojpQQFYsdBQjWBpnVxDXtk6YbVjnxFGwsrLnE",
        distinct_id: distinctId,
        event: "get_text_clicked",
        properties: expect.objectContaining({
          app: "bigecho",
          distinct_id: distinctId,
          session_id: "s1",
          surface: "sessions",
          timezone: expect.any(String),
        }),
      })
    );
  });

  it("uses fetch instead of sendBeacon so delivery failures are observable", async () => {
    setAnalyticsEnabledForTests(true);
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, text: async () => "" }));
    const sendBeaconMock = vi.fn(() => true);
    vi.stubGlobal("fetch", fetchMock);
    Object.defineProperty(window.navigator, "sendBeacon", {
      configurable: true,
      value: sendBeaconMock,
    });

    await captureAnalyticsEvent("rec_clicked", {
      source: "slack",
      surface: "tray",
    });

    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith(
      "https://us.i.posthog.com/i/v0/e/",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
    );
  });
});
