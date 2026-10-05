import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const products = vi.hoisted(() => ({
  list: [] as Array<Record<string, unknown>>,
}));

vi.mock("@workspace/api-client-react", async () => {
  const { createApiClientMock } = await import("../test/apiClientMock");
  return createApiClientMock({
    useListBrandProducts: () => ({ data: products.list, isLoading: false }),
  });
});

import { GuidedProductPicker, SceneProductToggles } from "./brand-products";

function wrap(node: ReactNode) {
  return <QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>;
}

const item = (id: number, name: string) => ({
  id,
  brandKitId: 1,
  imagePath: `/objects/1/uploads/${id}`,
  mimeType: "image/png",
  name,
  kind: "product",
  description: "desc",
  displayMode: "in_scene",
  aiDescription: null,
  aiDescriptionStatus: "ready",
  createdAt: "2026-01-01T00:00:00.000Z",
});

beforeEach(() => {
  cleanup();
  products.list = [item(1, "Serum"), item(2, "Cream"), item(3, "Mask"), item(4, "Toner"), item(5, "Oil")];
});

describe("GuidedProductPicker", () => {
  it("asks for a Brand Kit before showing products", () => {
    render(wrap(
      <GuidedProductPicker brandKitId={null} selected={[]} onSelectedChange={() => {}} promotion="featured" onPromotionChange={() => {}} />,
    ));
    expect(screen.getByTestId("text-guided-products-need-kit")).toBeTruthy();
  });

  it("toggles products and caps the selection at four", () => {
    const onSelectedChange = vi.fn();
    const { rerender } = render(wrap(
      <GuidedProductPicker brandKitId={1} selected={[]} onSelectedChange={onSelectedChange} promotion="featured" onPromotionChange={() => {}} />,
    ));
    fireEvent.click(screen.getByTestId("button-guided-product-2"));
    expect(onSelectedChange).toHaveBeenLastCalledWith([2]);

    rerender(wrap(
      <GuidedProductPicker brandKitId={1} selected={[1, 2, 3, 4]} onSelectedChange={onSelectedChange} promotion="featured" onPromotionChange={() => {}} />,
    ));
    expect((screen.getByTestId("button-guided-product-5") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId("button-guided-product-1"));
    expect(onSelectedChange).toHaveBeenLastCalledWith([2, 3, 4]);
    expect(screen.getByTestId("text-guided-promotion-help").textContent).toMatch(/call to action/);
  });

  it("switches promotion level", () => {
    const onPromotionChange = vi.fn();
    render(wrap(
      <GuidedProductPicker brandKitId={1} selected={[1]} onSelectedChange={() => {}} promotion="featured" onPromotionChange={onPromotionChange} />,
    ));
    fireEvent.click(screen.getByTestId("toggle-guided-promotion-subtle"));
    expect(onPromotionChange).toHaveBeenCalledWith("subtle");
  });
});

describe("SceneProductToggles", () => {
  const frozen = [
    { id: "p1", name: "Serum", imagePath: "/objects/1/uploads/1" },
    { id: "p2", name: "Cream", imagePath: "/objects/1/uploads/2" },
    { id: "p3", name: "Mask", imagePath: "/objects/1/uploads/3" },
  ];

  it("renders nothing when the story promotes no products", () => {
    const { container } = render(<SceneProductToggles products={[]} productIds={[]} onChange={() => {}} sceneLabel="s1" />);
    expect(container.textContent).toBe("");
  });

  it("adds and removes scene products, at most two per scene", () => {
    const onChange = vi.fn();
    const { rerender } = render(<SceneProductToggles products={frozen} productIds={["p1"]} onChange={onChange} sceneLabel="s1" />);
    fireEvent.click(screen.getByTestId("toggle-scene-product-s1-p2"));
    expect(onChange).toHaveBeenLastCalledWith(["p1", "p2"]);
    fireEvent.click(screen.getByTestId("toggle-scene-product-s1-p1"));
    expect(onChange).toHaveBeenLastCalledWith([]);
    rerender(<SceneProductToggles products={frozen} productIds={["p1", "p2"]} onChange={onChange} sceneLabel="s1" />);
    expect((screen.getByTestId("toggle-scene-product-s1-p3") as HTMLButtonElement).disabled).toBe(true);
  });
});
