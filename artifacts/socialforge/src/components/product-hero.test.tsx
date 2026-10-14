import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProductScreenTimeMeter, SceneShotPicker } from "./product-hero";

describe("ProductScreenTimeMeter", () => {
  it("shows the share against the target and nudges when low", () => {
    const { rerender } = render(<ProductScreenTimeMeter screenTime={{ seconds: 21, share: 0.7, runtime: 30, target: 0.7 }} />);
    expect(screen.getByText("Product on screen: 70%")).toBeTruthy();
    expect(screen.queryByText(/Tag more scenes/)).toBeNull();
    rerender(<ProductScreenTimeMeter screenTime={{ seconds: 12, share: 0.4, runtime: 30, target: 0.7 }} />);
    expect(screen.getByText(/Tag more scenes/)).toBeTruthy();
  });

  it("renders nothing for non-hero stories", () => {
    const { container } = render(<ProductScreenTimeMeter screenTime={null} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("SceneShotPicker", () => {
  it("offers only the angles the product has photos of", () => {
    render(<SceneShotPicker shot={{ type: "macro_closeup", camera: "orbit", lighting: "rim_light", angle: "label" }} views={["front", "label"]} sceneLabel="s1" onChange={vi.fn()} />);
    expect(screen.getByTestId("select-shot-type-s1").textContent).toContain("Macro close-up");
    expect(screen.getByTestId("select-shot-camera-s1").textContent).toContain("Orbit");
    expect(screen.getByTestId("select-shot-angle-s1").textContent).toContain("Label");
  });
});
