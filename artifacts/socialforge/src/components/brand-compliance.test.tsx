import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { BrandComplianceSection } from "./brand-compliance";

if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const calls: { detect: any[]; check: any[] } = { detect: [], check: [] };
let detected: string | null = "medical";

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
  useListComplianceRulePacks: () => ({
    data: [
      {
        id: "nmc-medical-advertising",
        version: "2026.10.1",
        profession: "medical",
        label: "Doctor (NMC)",
        regulator: "National Medical Commission",
        summary: "Educational content only.",
        sources: [{ title: "IMC Regulations 2002", url: null, note: null }],
        rules: [
          { id: "nmc.guarantee", title: "No guaranteed results or cures", source: "§6.1", severity: "block", instruction: "", fields: ["spoken"] },
        ],
        visualNegatives: [],
      },
    ],
  }),
  useDetectComplianceProfession: () => ({
    mutate: (vars: any, opts: any) => {
      calls.detect.push(vars);
      opts?.onSuccess?.({ profession: detected });
    },
  }),
  useCheckComplianceText: () => ({
    isPending: false,
    mutate: (vars: any, opts: any) => {
      calls.check.push(vars);
      opts?.onSuccess?.({
        profession: "medical",
        packId: "nmc-medical-advertising",
        packVersion: "2026.10.1",
        blocking: 1,
        review: 0,
        findings: [
          { ruleId: "nmc.guarantee", title: "No guaranteed results or cures", severity: "block", source: "§6.1", field: "caption", location: "Text", match: "guaranteed", excerpt: "guaranteed results" },
        ],
      });
    },
  }),
  });
});

function draft(industry: string, compliance: any = null): any {
  return {
    identity: { brand_name: "Clinic", brand_slug: "clinic", tagline: "", description: "", industry, audience: [] },
    brand_controls: { approved: true, approval_status: "approved", allowed_use_cases: [], restricted_terms: [] },
    compliance,
  };
}

describe("BrandComplianceSection", () => {
  beforeEach(() => {
    cleanup();
    calls.detect = [];
    calls.check = [];
    detected = "medical";
  });

  it("auto-detects Doctor from Industry and asks for confirmation", async () => {
    const onChange = vi.fn();
    render(<BrandComplianceSection kitId={7} draft={draft("Doctor")} onChange={onChange} />);
    expect(screen.getByText(/Checking Business\/Industry/)).toBeTruthy();
    expect(screen.queryByText(/No regulated profession detected/)).toBeNull();
    await waitFor(() => expect(calls.detect[0]?.data.industry).toBe("Doctor"));
    expect(await screen.findByText(/Doctor \(NMC\) rules apply/)).toBeTruthy();
    fireEvent.click(screen.getByTestId("button-confirm-compliance"));
    const saved = onChange.mock.calls.at(-1)![0];
    expect(saved.profession).toBe("medical");
    expect(saved.confirmed_at).toBeTruthy();
  });

  it("shows nothing regulated for other industries", async () => {
    detected = null;
    render(<BrandComplianceSection kitId={7} draft={draft("Bakery")} onChange={vi.fn()} />);
    expect(await screen.findByText(/No regulated profession detected/)).toBeTruthy();
    expect(screen.queryByTestId("input-compliance-registration")).toBeNull();
  });

  it("records verified facts and runs the test check", async () => {
    const onChange = vi.fn();
    const saved = {
      profession: "medical",
      source: "manual",
      confirmed_at: "2026-10-04T00:00:00Z",
      facts: { practitioner_name: "", registration_number: "", registering_body: "", qualifications: [], services: [], practice_address: "", verified_claims: [] },
      extra_negative_terms: [],
    };
    render(<BrandComplianceSection kitId={7} draft={draft("Doctor", saved)} onChange={onChange} />);
    fireEvent.change(screen.getByTestId("input-compliance-registration"), { target: { value: "TSMC/1" } });
    expect(onChange.mock.calls.at(-1)![0].facts.registration_number).toBe("TSMC/1");
    fireEvent.change(screen.getByTestId("input-compliance-test"), { target: { value: "guaranteed results" } });
    fireEvent.click(screen.getByTestId("button-run-compliance-check"));
    expect(calls.check[0].data).toMatchObject({ text: "guaranteed results", brandKitId: 7 });
    expect(await screen.findByText(/Must fix · No guaranteed results/)).toBeTruthy();
  });
});
