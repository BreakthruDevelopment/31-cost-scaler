import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DriftResult } from "@/components/admin/drift-result";
import type { DriftReport } from "@/lib/footprint/stack-profiles";

const render = (files: DriftReport["files"], mismatches: DriftReport["mismatches"] = []) =>
  renderToStaticMarkup(createElement(DriftResult, { drift: { files, mismatches }, checkedOn: "2026-11-17 10:00 UTC" }));
const all = (s: "checked" | "unavailable"): DriftReport["files"] => ({ aws: s, azure: s, gcp: s, oci: s });

describe("the drift result never reads as all-clear over files it could not read", () => {
  it("all checked and clean: the green all-clear", () => {
    const html = render(all("checked"));
    expect(html).toContain("No drift: every value");
    expect(html).toContain("bg-live-soft");
  });

  it("some unchecked, no mismatches: incomplete, names both sides, nothing green", () => {
    const html = render({ ...all("checked"), azure: "unavailable" });
    expect(html).toContain("Incomplete");
    expect(html).toContain("Not checked this run: Azure");
    expect(html).not.toContain("No drift: every value");
    expect(html).not.toContain("bg-live-soft");
  });

  it("some unchecked with a mismatch: the mismatch alert shows, nothing green", () => {
    const html = render({ ...all("checked"), azure: "unavailable" }, [{ key: "aws.lambda.memory_mb", expected: "1024", actual: "2048" }]);
    expect(html).toContain("no longer match");
    expect(html).not.toContain("bg-live-soft");
  });

  it("none checked: unknown, no drift result and nothing green", () => {
    const html = render(all("unavailable"));
    expect(html).toContain("Drift is unknown");
    expect(html).not.toContain("No drift");
    expect(html).not.toContain("Incomplete");
    expect(html).not.toContain("bg-live-soft");
  });
});
