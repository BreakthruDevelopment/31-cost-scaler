import { describe, expect, it } from "vitest";
import { BASE_SPEC } from "@/lib/pricing/spec";
import { MAX_NAME, checkDraft, copyName, draftFromSpec, num, specInputFromDraft } from "@/lib/scenario-draft";

const draft = (over: Partial<ReturnType<typeof draftFromSpec>> = {}) => ({ ...draftFromSpec("My plan", BASE_SPEC), ...over });

describe("the builder's draft", () => {
  it("round-trips a spec through the form and back", () => {
    const d = draftFromSpec("My plan", BASE_SPEC);
    expect(d.users.mau).toBe("500");
    expect(d.compute.busyFraction).toBe("0.1");
    expect(d.baseApp).toBe("");
    const checked = checkDraft(d);
    expect(checked.ok).toBe(true);
    if (checked.ok) {
      expect(checked.name).toBe("My plan");
      expect(checked.spec).toEqual(BASE_SPEC);
    }
  });

  it("keeps a base app when one is chosen, and leaves the key out when it is not", () => {
    expect(specInputFromDraft(draft({ baseApp: "helpdesk" }))).toMatchObject({ baseApp: "helpdesk" });
    expect(specInputFromDraft(draft({ baseApp: "  " }))).not.toHaveProperty("baseApp");
  });

  it("treats an empty or non-numeric field as missing, never as zero", () => {
    expect(num("")).toBeNaN();
    expect(num("  ")).toBeNaN();
    expect(num("abc")).toBeNaN();
    expect(num(" 2.5 ")).toBe(2.5);
    const checked = checkDraft(draft({ database: { vcpu: "1", memoryGb: "1", storageGb: "", readReplicas: "0" } }));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.map((i) => i.field)).toContain("database.storageGb");
  });

  it("reports every out-of-range field with the path the form labels it with", () => {
    const checked = checkDraft(
      draft({
        name: "",
        users: { mau: "20000000", requestsPerUser: "0" },
        loadBalancers: "9",
      }),
    );
    expect(checked.ok).toBe(false);
    if (checked.ok) return;
    const fields = checked.issues.map((i) => i.field);
    expect(fields).toContain("name");
    expect(fields).toContain("users.mau");
    expect(fields).toContain("users.requestsPerUser");
    expect(fields).toContain("loadBalancers");
  });

  it("refuses a name with a NUL byte, like the server does", () => {
    const checked = checkDraft(draft({ name: "nul\u0000byte" }));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.some((i) => i.field === "name")).toBe(true);
  });

  it("refuses a name over the cap and trims the one it accepts", () => {
    expect(checkDraft(draft({ name: "x".repeat(MAX_NAME + 1) })).ok).toBe(false);
    const ok = checkDraft(draft({ name: "  spaced  " }));
    expect(ok.ok && ok.name).toBe("spaced");
  });

  it("refuses a base app that is not an app name", () => {
    const checked = checkDraft(draft({ baseApp: "Not An App" }));
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.issues.map((i) => i.field)).toContain("baseApp");
  });

  it("names a copy within the 80-character cap, keeping the suffix", () => {
    expect(copyName("Plan A")).toBe("Plan A (copy)");
    const long = copyName("y".repeat(MAX_NAME));
    expect(long.length).toBe(MAX_NAME);
    expect(long.endsWith(" (copy)")).toBe(true);
  });
});
