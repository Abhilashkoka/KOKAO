import { describe, it, expect } from "vitest";
import {
  BASE_LAYER_ID,
  cloneLayer,
  findLayer,
  findParent,
  flattenLayers,
  groupLayers,
  insertLayer,
  makeGroupLayer,
  makeImageLayer,
  makeTextLayer,
  mapLayer,
  migrateDoc,
  removeLayer,
  reorderLayer,
  ungroupLayer,
  type GroupLayer,
  type ImageLayer,
  type Layer,
  type TextLayer,
} from "./doc";

/**
 * The migration tests matter more than the rest of this file put together:
 * every v1 document that fails to migrate is a post a user can no longer edit,
 * and the failure is silent — they just see an empty canvas.
 */
describe("migrateDoc", () => {
  it("turns a v1 document into v2 with the base image as a real layer", () => {
    const v1 = {
      version: 1,
      basePath: "/objects/1/uploads/base",
      layers: [
        {
          id: "t1",
          type: "text",
          text: "Hello",
          x: 10,
          y: 20,
          fontSize: 48,
          fill: "#ff0000",
          fontFamily: "Inter",
          fontStyle: "bold",
          rotation: 0,
          scaleX: 1,
          scaleY: 1,
        },
      ],
    };

    const doc = migrateDoc(v1, "/objects/1/uploads/flattened", 1024, 768);

    expect(doc.version).toBe(2);
    expect(doc.width).toBe(1024);
    expect(doc.height).toBe(768);
    // Resumes on the ORIGINAL base, not on the flattened result, or the old
    // layers would be baked in twice.
    expect(doc.basePath).toBe("/objects/1/uploads/base");

    const base = doc.layers[0] as ImageLayer;
    expect(base.id).toBe(BASE_LAYER_ID);
    expect(base.type).toBe("image");
    expect(base.objectPath).toBe("/objects/1/uploads/base");

    const text = doc.layers[1] as TextLayer;
    expect(text.type).toBe("text");
    expect(text.text).toBe("Hello");
    expect(text.x).toBe(10);
  });

  it("moves a v1 text colour from `fill` to `color`", () => {
    // v1 used `fill` for the colour; v2 uses `fill` for an opacity. Reading the
    // old key is the difference between a red heading and a black one.
    const doc = migrateDoc(
      {
        version: 1,
        basePath: "/objects/1/uploads/base",
        layers: [{ id: "t", type: "text", text: "Hi", fill: "#ff0000", fontStyle: "bold" }],
      },
      "/objects/1/uploads/base",
      512,
      512,
    );
    const text = doc.layers[1] as TextLayer;
    expect(text.color).toBe("#ff0000");
    expect(text.fill).toBe(1);
    expect(text.fontWeight).toBe(700);
  });

  it("carries a v1 element layer's opacity and multiply blend through", () => {
    const doc = migrateDoc(
      {
        version: 1,
        basePath: "/b",
        layers: [
          { id: "e", type: "image", objectPath: "/objects/1/uploads/logo", width: 100, height: 50, opacity: 0.4, blend: "multiply", name: "shadow" },
        ],
      },
      "/b",
      512,
      512,
    );
    const element = doc.layers[1] as ImageLayer;
    expect(element.opacity).toBe(0.4);
    expect(element.blend).toBe("multiply");
    expect(element.name).toBe("shadow");
  });

  it("round-trips a v2 document unchanged", () => {
    const original = migrateDoc(null, "/objects/1/uploads/base", 800, 600);
    const again = migrateDoc(original, "/other", 800, 600);
    expect(again.basePath).toBe("/objects/1/uploads/base");
    expect(again.layers).toHaveLength(1);
    expect(again.layers[0].id).toBe(BASE_LAYER_ID);
  });

  it("seeds a base layer for junk, null, and empty documents", () => {
    for (const input of [null, undefined, 42, "nope", {}, { version: 2, layers: [] }]) {
      const doc = migrateDoc(input, "/objects/1/uploads/base", 640, 480);
      expect(doc.version).toBe(2);
      expect(doc.layers).toHaveLength(1);
      expect(doc.layers[0].id).toBe(BASE_LAYER_ID);
    }
  });

  it("drops layers it cannot render rather than throwing", () => {
    const doc = migrateDoc(
      {
        version: 2,
        basePath: "/b",
        width: 100,
        height: 100,
        layers: [
          { id: "ok", type: "image", objectPath: "/objects/1/uploads/a", width: 10, height: 10 },
          { id: "bad", type: "image" }, // no objectPath: nothing to draw
          { id: "alien", type: "hologram" },
          null,
        ],
      },
      "/b",
      100,
      100,
    );
    expect(doc.layers.map((l) => l.id)).toEqual(["ok"]);
  });

  it("normalises an unsupported blend mode to normal instead of guessing", () => {
    const doc = migrateDoc(
      {
        version: 2,
        basePath: "/b",
        width: 10,
        height: 10,
        layers: [{ id: "a", type: "image", objectPath: "/o", blend: "vivid-light" }],
      },
      "/b",
      10,
      10,
    );
    expect(doc.layers[0].blend).toBe("normal");
  });

  it("clamps hostile numbers and caps group nesting", () => {
    let nested: Record<string, unknown> = { id: "deep", type: "image", objectPath: "/o" };
    for (let i = 0; i < 40; i += 1) {
      nested = { id: `g${i}`, type: "group", children: [nested] };
    }
    const doc = migrateDoc(
      { version: 2, basePath: "/b", width: 10, height: 10, layers: [nested, { id: "x", type: "image", objectPath: "/o", opacity: 99, rotation: 1e9 }] },
      "/b",
      10,
      10,
    );
    const flat = flattenLayers(doc.layers);
    expect(flat.length).toBeLessThan(40);
    const x = findLayer(doc.layers, "x");
    expect(x?.opacity).toBe(1);
    expect(x?.rotation).toBe(3600);
  });
});

describe("layer tree operations", () => {
  const build = (): Layer[] => {
    const a = makeImageLayer("/o/a", 10, 10, "A");
    a.id = "a";
    const b = makeTextLayer("B", 20);
    b.id = "b";
    const c = makeImageLayer("/o/c", 10, 10, "C");
    c.id = "c";
    const group = makeGroupLayer([b, c], "G");
    group.id = "g";
    return [a, group];
  };

  it("finds layers and their parents at any depth", () => {
    const layers = build();
    expect(findLayer(layers, "c")?.name).toBe("C");
    expect(findParent(layers, "c")?.id).toBe("g");
    expect(findParent(layers, "a")).toBeNull();
    expect(findLayer(layers, "missing")).toBeNull();
  });

  it("flattens in paint order with depths", () => {
    const flat = flattenLayers(build());
    expect(flat.map((f) => f.layer.id)).toEqual(["a", "g", "b", "c"]);
    expect(flat.map((f) => f.depth)).toEqual([0, 0, 1, 1]);
  });

  it("maps a nested layer without touching its siblings", () => {
    const layers = build();
    const next = mapLayer(layers, "c", (l) => ({ ...l, name: "renamed" }));
    expect(findLayer(next, "c")?.name).toBe("renamed");
    // The untouched top-level layer keeps its identity, so React can skip it.
    expect(next[0]).toBe(layers[0]);
  });

  it("is a no-op for an id that is not in the tree", () => {
    const layers = build();
    expect(mapLayer(layers, "ghost", (l) => ({ ...l, name: "x" }))).toBe(layers);
    expect(reorderLayer(layers, "ghost", 1)).toBe(layers);
  });

  it("removes nested layers", () => {
    const next = removeLayer(build(), "b");
    expect(findLayer(next, "b")).toBeNull();
    expect((findLayer(next, "g") as GroupLayer).children).toHaveLength(1);
  });

  it("inserts directly above a sibling, or on top when none is given", () => {
    const layers = build();
    const fresh = makeImageLayer("/o/n", 5, 5, "N");
    expect(insertLayer(layers, fresh, "a").map((l) => l.id)).toEqual(["a", fresh.id, "g"]);
    expect(insertLayer(layers, fresh, null).map((l) => l.id)).toEqual(["a", "g", fresh.id]);
  });

  it("reorders within a parent and refuses to run off either end", () => {
    const layers = build();
    expect(reorderLayer(layers, "a", 1).map((l) => l.id)).toEqual(["g", "a"]);
    expect(reorderLayer(layers, "a", -1)).toBe(layers);
    const inner = reorderLayer(layers, "b", 1);
    expect((findLayer(inner, "g") as GroupLayer).children.map((l) => l.id)).toEqual(["c", "b"]);
  });

  it("groups siblings in place and ungroups back", () => {
    const layers = build();
    const { layers: grouped, groupId } = groupLayers(layers, ["a"]);
    expect(groupId).toBeTruthy();
    expect(grouped.map((l) => l.id)).toEqual([groupId, "g"]);
    expect((grouped[0] as GroupLayer).children.map((l) => l.id)).toEqual(["a"]);

    const ungrouped = ungroupLayer(grouped, groupId as string);
    expect(ungrouped.map((l) => l.id)).toEqual(["a", "g"]);
  });

  it("only creates one group even when ids span parents", () => {
    const { layers, groupId } = groupLayers(build(), ["a", "c"]);
    expect(groupId).toBeTruthy();
    const groups = flattenLayers(layers).filter((f) => f.layer.type === "group");
    // The pre-existing group plus exactly one new one.
    expect(groups).toHaveLength(2);
  });

  it("gives a cloned group fresh ids all the way down", () => {
    const original = build()[1] as GroupLayer;
    const copy = cloneLayer(original) as GroupLayer;
    expect(copy.id).not.toBe(original.id);
    expect(copy.children.map((c) => c.id)).not.toEqual(original.children.map((c) => c.id));
    expect(copy.children).toHaveLength(2);
  });
});
