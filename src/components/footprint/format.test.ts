import { describe, expect, it } from "vitest";
import { SOURCE_LABEL_MAX, VERDICT, sourceHost, usd } from "./format";

describe("sourceHost", () => {
  it("shows the host, without www", () => {
    expect(sourceHost("https://aws.amazon.com/lambda/pricing/")).toBe("aws.amazon.com");
    expect(sourceHost("https://www.oracle.com/cloud/price-list/")).toBe("oracle.com");
  });

  it("never returns an empty label, so a row is never blank", () => {
    // `new URL()` parses these, but the hostname is "": the old code rendered nothing at all.
    const hostless = ["javascript:alert(1)", "data:text/html,x", "mailto:prices@example.test", "about:blank"];
    for (const url of [...hostless, "/relative/path", "not a url", "   ", ""]) {
      expect(sourceHost(url), url).not.toBe("");
    }
  });

  it("falls back to the raw value, capped, for a URL with no hostname", () => {
    expect(sourceHost("javascript:alert(1)")).toBe("javascript:alert(1)");
    expect(sourceHost("  /relative/path  ")).toBe("/relative/path");
    expect(sourceHost("")).toBe("source");
    const long = `javascript:${"x".repeat(200)}`;
    expect(sourceHost(long)).toHaveLength(SOURCE_LABEL_MAX);
    expect(sourceHost(long).endsWith("…")).toBe(true);
  });
});

describe("usd", () => {
  it("separates a true zero from an amount too small to show", () => {
    expect(usd(0)).toBe("$0.00");
    expect(usd(1)).toBe("<$0.01");
    expect(usd(-1)).toBe("-<$0.01");
    expect(usd(1_000_000)).toBe("$1.00");
  });
});

describe("VERDICT", () => {
  it("carries only the badge: the prose belongs to the engine's reasons", () => {
    // Guards the finding in #19: interpolated copy that nothing renders drifts from the engine that owns the number.
    for (const v of Object.values(VERDICT)) {
      expect(Object.keys(v).sort()).toEqual(["label", "status"]);
    }
  });
});
