import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import {
  EMPTY_PROMO_OVERLAYS,
  GuidedPromoOverlaysEditor,
  promoOverlaysInput,
  promoOverlaysProblem,
  type PromoOverlaysValue,
} from "./guided-promo-overlays";

afterEach(cleanup);

function Harness({ hasFootage = false, onValue }: { hasFootage?: boolean; onValue: (value: PromoOverlaysValue) => void }) {
  const [value, setValue] = useState(EMPTY_PROMO_OVERLAYS);
  return (
    <GuidedPromoOverlaysEditor
      value={value}
      hasFootage={hasFootage}
      onChange={(next) => {
        setValue(next);
        onValue(next);
      }}
    />
  );
}

describe("promo overlays payload", () => {
  it("is null when nothing is set, so the server clears it", () => {
    expect(promoOverlaysInput(EMPTY_PROMO_OVERLAYS)).toBeNull();
  });

  it("drops blank lines and sends the bubble only when on", () => {
    expect(promoOverlaysInput({
      textOverlays: [
        { key: "a", text: "  ₹999  only ", position: "top", timing: "start", style: "red" },
        { key: "b", text: " ", position: "middle", timing: "whole", style: "yellow" },
      ],
      faceBubble: { enabled: false, corner: "top_left" },
    })).toEqual({ version: 1, textOverlays: [{ text: "₹999 only", position: "top", timing: "start", style: "red" }], faceBubble: null });
  });

  it("flags lines over 60 characters", () => {
    expect(promoOverlaysProblem({ ...EMPTY_PROMO_OVERLAYS, textOverlays: [{ key: "a", text: "x".repeat(61), position: "top", timing: "start", style: "red" }] }))
      .toMatch(/60 characters/);
  });
});

describe("GuidedPromoOverlaysEditor", () => {
  it("adds up to three lines with hook, offer and shop-name defaults", () => {
    let latest = EMPTY_PROMO_OVERLAYS;
    render(<Harness onValue={(value) => { latest = value; }} />);
    for (let i = 0; i < 3; i += 1) fireEvent.click(screen.getByTestId("button-add-promo-text"));
    expect(screen.queryByTestId("button-add-promo-text")).toBeNull();
    expect(latest.textOverlays.map((row) => [row.position, row.timing, row.style])).toEqual([
      ["top", "start", "red"],
      ["middle", "whole", "yellow"],
      ["bottom", "end", "black"],
    ]);
  });

  it("asks for a footage upload when the bubble is on without one", () => {
    render(<Harness onValue={() => {}} />);
    fireEvent.click(screen.getByTestId("switch-guided-face-bubble"));
    expect(screen.getByTestId("status-face-bubble-needs-footage")).toBeTruthy();
  });

  it("hides the footage hint when footage exists", () => {
    render(<Harness hasFootage onValue={() => {}} />);
    fireEvent.click(screen.getByTestId("switch-guided-face-bubble"));
    expect(screen.queryByTestId("status-face-bubble-needs-footage")).toBeNull();
  });
});
