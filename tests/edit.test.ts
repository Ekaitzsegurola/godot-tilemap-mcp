import { describe, expect, it } from "vitest";
import { planEdit } from "../src/core/edit.js";
import type { SceneSnapshot } from "../src/core/project.js";

const snapshot: SceneSnapshot = {
  project: "/synthetic/project",
  scenePath: "/synthetic/project/world.tscn",
  resourcePath: "res://world.tscn",
  revision: "a".repeat(64),
  text: "",
  layers: [{
    descriptor: {
      name: "Ground",
      parent: "World",
      fullPath: "World/Ground",
      nodePath: "World/Ground",
      tileMapDataBase64: "",
      tileSetKind: null,
      tileSetId: null,
      tileSetPath: null,
      zIndex: 0,
      visible: true,
      enabled: true,
      position: { x: 0, y: 0 },
    },
    formatVersion: 0,
    cells: [],
    bounds: null,
    tileSet: null,
  }],
};

describe("deterministic recipe planner", () => {
  it("produces identical scatter diffs for the same seed", async () => {
    const recipe = {
      scenePath: "res://world.tscn",
      seed: "stable",
      operations: [{
        op: "scatter" as const,
        layer: "World/Ground",
        region: { x: 0, y: 0, width: 8, height: 8 },
        density: 0.4,
        tile: { sourceId: 0, atlasX: 0, atlasY: 0, alternativeId: 0 },
      }],
    };
    const first = await planEdit(snapshot, recipe, null, null);
    const second = await planEdit(snapshot, recipe, null, null);
    expect(second.layers[0]?.nextBase64).toBe(first.layers[0]?.nextBase64);
    expect(first.layers[0]?.changes.length).toBeGreaterThan(0);
  });
});
