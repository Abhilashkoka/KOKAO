import { describe, expect, it } from "vitest";
import type { GuidedStoryScript } from "@workspace/db";
import {
  MIN_SHOT_MS,
  expandScriptCoverage,
  eyelineForRole,
  planSceneCoverage,
  shotVisualDirection,
} from "./guidedCoverage";

type Scene = GuidedStoryScript["scenes"][number];

const line = (
  id: string,
  owner: string | null,
  startMs: number,
  endMs: number,
) => ({
  id,
  ownerRoleId: owner,
  kind: (owner ? "dialogue" : "narration") as "dialogue" | "narration",
  text: `${id} text`,
  startMs,
  endMs,
});

const scene = (overrides: Partial<Scene> = {}): Scene => ({
  id: "sc1",
  startMs: 0,
  endMs: 8000,
  visualDirection: "A busy hospital corridor, afternoon light.",
  roleIds: ["asha", "ravi"],
  lines: [
    line("l1", "asha", 0, 2500),
    line("l2", "ravi", 2500, 5200),
    line("l3", "asha", 5200, 8000),
  ],
  ...overrides,
});

const script = (scenes: Scene[]): GuidedStoryScript => ({
  version: 1,
  title: "t",
  logline: "l",
  runtimeSeconds: 30,
  roles: [
    { id: "asha", name: "Asha", description: "" },
    { id: "ravi", name: "Ravi", description: "" },
    { id: "meera", name: "Meera", description: "" },
  ],
  scenes,
  warnings: [],
});

describe("planSceneCoverage", () => {
  it("gives every speaking turn a shot framed on exactly one speaker", () => {
    const shots = planSceneCoverage(scene());
    expect(shots).toHaveLength(3);
    for (const shot of shots) {
      expect(shot.roleIds).toHaveLength(1);
      expect(shot.roleIds[0]).toBe(shot.speakerRoleId);
    }
    expect(shots.map((shot) => shot.speakerRoleId)).toEqual([
      "asha",
      "ravi",
      "asha",
    ]);
  });

  it("never caps how many characters a scene may hold", () => {
    const cast = ["a", "b", "c", "d", "e", "f"];
    const shots = planSceneCoverage(
      scene({ roleIds: cast, lines: [line("l1", null, 0, 8000)] }),
    );
    expect(shots).toHaveLength(1);
    expect(shots[0]!.roleIds).toEqual(cast);
  });

  it("keeps the whole cast where nobody is singled out", () => {
    const shots = planSceneCoverage(
      scene({
        roleIds: ["asha", "ravi", "meera"],
        lines: [
          line("l1", null, 0, 3000),
          line("l2", "asha", 3000, 5500),
          line("l3", "ravi", 5500, 8000),
        ],
      }),
    );
    expect(shots.find((shot) => shot.kind === "group")?.roleIds).toEqual([
      "asha",
      "ravi",
      "meera",
    ]);
    expect(
      shots
        .filter((shot) => shot.kind === "single")
        .every((shot) => shot.roleIds.length === 1),
    ).toBe(true);
  });

  it("leaves a scene alone when coverage would gain nothing", () => {
    expect(planSceneCoverage(scene({ roleIds: ["asha"] }))).toHaveLength(1);
    expect(
      planSceneCoverage(scene({ lines: [line("n", null, 0, 8000)] })),
    ).toHaveLength(1);
    expect(
      planSceneCoverage(
        scene({
          lines: [
            line("l1", "asha", 0, 4000),
            line("l2", "asha", 4000, 8000),
          ],
        }),
      ),
    ).toHaveLength(1);
  });

  it("holds on the running shot rather than flashing a short line", () => {
    const shots = planSceneCoverage(
      scene({
        lines: [
          line("l1", "asha", 0, 3000),
          line("l2", "ravi", 3000, 3400),
          line("l3", "asha", 3400, 8000),
        ],
      }),
    );
    expect(
      shots.every((shot) => shot.endMs - shot.startMs >= MIN_SHOT_MS),
    ).toBe(true);
    expect(shots.length).toBeLessThan(3);
  });

  it("merges adjacent lines by the same speaker into one turn", () => {
    const shots = planSceneCoverage(
      scene({
        lines: [
          line("l1", "asha", 0, 2000),
          line("l2", "asha", 2000, 4000),
          line("l3", "ravi", 4000, 8000),
        ],
      }),
    );
    expect(shots).toHaveLength(2);
    expect(shots[0]!.lineIds).toEqual(["l1", "l2"]);
  });

  it("tiles the scene span exactly", () => {
    const original = scene();
    const shots = planSceneCoverage(original);
    expect(shots[0]!.startMs).toBe(original.startMs);
    expect(shots.at(-1)!.endMs).toBe(original.endMs);
    for (let index = 1; index < shots.length; index += 1) {
      expect(shots[index]!.startMs).toBe(shots[index - 1]!.endMs);
    }
  });
});

describe("eyelineForRole", () => {
  it("puts two speakers on opposite eyelines", () => {
    expect(eyelineForRole("asha", ["asha", "ravi"])).toBe("right");
    expect(eyelineForRole("ravi", ["asha", "ravi"])).toBe("left");
  });

  it("holds a role eyeline across shots", () => {
    const ashaShots = planSceneCoverage(scene()).filter(
      (shot) => shot.speakerRoleId === "asha",
    );
    expect(ashaShots).toHaveLength(2);
    expect(new Set(ashaShots.map((shot) => shot.eyeline)).size).toBe(1);
  });

  it("faces camera beyond two roles", () => {
    expect(eyelineForRole("meera", ["asha", "ravi", "meera"])).toBe(
      "center",
    );
  });
});

describe("expandScriptCoverage", () => {
  it("preserves line identity, ownership and timing", () => {
    const before = script([scene()]);
    const after = expandScriptCoverage(before);
    const flatten = (value: GuidedStoryScript) =>
      value.scenes.flatMap((item) =>
        item.lines.map((itemLine) => [
          itemLine.id,
          itemLine.ownerRoleId,
          itemLine.startMs,
          itemLine.endMs,
          itemLine.text,
        ]),
      );
    expect(flatten(after)).toEqual(flatten(before));
  });

  it("keeps the overall timeline continuous", () => {
    const after = expandScriptCoverage(
      script([
        scene(),
        scene({
          id: "sc2",
          startMs: 8000,
          endMs: 16000,
          lines: [
            line("m1", "asha", 8000, 11000),
            line("m2", "ravi", 11000, 16000),
          ],
        }),
      ]),
    );
    expect(after.scenes[0]!.startMs).toBe(0);
    expect(after.scenes.at(-1)!.endMs).toBe(16000);
    for (let index = 1; index < after.scenes.length; index += 1) {
      expect(after.scenes[index]!.startMs).toBe(
        after.scenes[index - 1]!.endMs,
      );
    }
  });

  it("leaves an unsplit scene byte-identical", () => {
    const solo = scene({ id: "solo", roleIds: ["asha"] });
    const after = expandScriptCoverage(script([solo]));
    expect(after.scenes).toHaveLength(1);
    expect(after.scenes[0]).toEqual(solo);
  });

  it("derives split ids from the authored beat", () => {
    expect(
      expandScriptCoverage(script([scene()])).scenes.map((item) => item.id),
    ).toEqual(["sc1-s1", "sc1-s2", "sc1-s3"]);
  });

  it("makes every speaking shot eligible for lip sync", () => {
    const after = expandScriptCoverage(script([scene()]));
    const eligible = after.scenes.filter((item) => {
      const owners = new Set(
        item.lines
          .filter((itemLine) => itemLine.kind === "dialogue" && itemLine.ownerRoleId)
          .map((itemLine) => itemLine.ownerRoleId!),
      );
      return (
        owners.size === 1 &&
        item.roleIds.length === 1 &&
        item.roleIds[0] === [...owners][0]
      );
    });
    expect(eligible).toHaveLength(3);
  });

  it("is idempotent", () => {
    const once = expandScriptCoverage(script([scene()]));
    expect(expandScriptCoverage(once)).toEqual(once);
  });

  it("stays inside the validator scene ceiling", () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      scene({
        id: `sc${index}`,
        startMs: index * 8000,
        endMs: (index + 1) * 8000,
        lines: [
          line(`a${index}`, "asha", index * 8000, index * 8000 + 2500),
          line(`b${index}`, "ravi", index * 8000 + 2500, index * 8000 + 5200),
          line(
            `c${index}`,
            "asha",
            index * 8000 + 5200,
            (index + 1) * 8000,
          ),
        ],
      }),
    );
    const after = expandScriptCoverage(script(many));
    expect(after.scenes.length).toBeLessThanOrEqual(40);
    expect(after.scenes.length).toBeGreaterThan(20);
    expect(after.scenes[0]!.startMs).toBe(0);
    expect(after.scenes.at(-1)!.endMs).toBe(160000);
  });

  it("spends the available scene budget", () => {
    const after = expandScriptCoverage(
      script([
        scene(),
        scene({
          id: "sc2",
          startMs: 8000,
          endMs: 16000,
          lines: [
            line("m1", "asha", 8000, 11000),
            line("m2", "ravi", 11000, 16000),
          ],
        }),
      ]),
      4,
    );
    expect(after.scenes.length).toBeLessThanOrEqual(4);
    expect(after.scenes.length).toBeGreaterThan(2);
  });
});

describe("shotVisualDirection", () => {
  it("carries location continuity into every shot", () => {
    for (const shot of planSceneCoverage(scene())) {
      const text = shotVisualDirection(
        "A busy hospital corridor, afternoon light.",
        shot,
      );
      expect(text).toContain("A busy hospital corridor");
      expect(text).toMatch(/same location, same lighting and same time of day/i);
    }
  });

  it("states the shot eyeline", () => {
    const shots = planSceneCoverage(scene());
    expect(shotVisualDirection("X.", shots[0]!)).toMatch(/screen-right/);
    expect(shotVisualDirection("X.", shots[1]!)).toMatch(/screen-left/);
  });

  it("frames a speaking shot on one character", () => {
    expect(
      shotVisualDirection("X.", planSceneCoverage(scene())[0]!),
    ).toMatch(/only the speaking character/i);
  });
});