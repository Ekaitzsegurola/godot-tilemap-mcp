import { describe, expect, it } from "vitest";
import { TileDataFormatError, decodeTileMapData, encodeTileMapData } from "../src/core/tileData.js";

describe("TileMapLayer data codec", () => {
  it("round-trips signed coordinates, alternatives, and the format header", () => {
    const encoded = encodeTileMapData([
      { x: -12, y: 34, sourceId: 7, atlasX: 8, atlasY: 9, alternativeId: 0x4002 },
    ], { formatVersion: 3 });
    expect(decodeTileMapData(encoded)).toMatchObject({
      formatVersion: 3,
      cells: [{ x: -12, y: 34, sourceId: 7, atlasX: 8, atlasY: 9, alternativeId: 0x4002 }],
      hadHeader: true,
    });
  });

  it("rejects truncated payloads instead of silently dropping bytes", () => {
    expect(() => decodeTileMapData(Buffer.alloc(3).toString("base64"))).toThrow(TileDataFormatError);
  });

  it("keeps the two-byte header when a layer becomes empty", () => {
    expect(Buffer.from(encodeTileMapData([], { formatVersion: 5 }), "base64")).toEqual(Buffer.from([5, 0]));
  });
});
