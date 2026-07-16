import { describe, expect, it } from "vitest";
import { findTileMapLayers, parseGodotText, patchTileMapData } from "../src/core/godotText.js";

describe("lossless Godot text editing", () => {
  it("discovers embedded TileSets and changes only the selected property line", () => {
    const source = "\uFEFF[gd_scene format=3]\r\n\r\n[sub_resource type=\"TileSet\" id=\"TileSet_demo\"]\r\ntile_size = Vector2i(16, 16)\r\n\r\n[node name=\"Ground\" type=\"TileMapLayer\" parent=\"World\"]\r\ntile_set = SubResource(\"TileSet_demo\")\r\ntile_map_data = PackedByteArray(\"AAAA\")\r\nmetadata/keep = \"exactly\"\r\n";
    const document = parseGodotText(source);
    const layer = findTileMapLayers(document)[0]!;
    expect(layer.tileSetKind).toBe("embedded");
    expect(layer.tileSetId).toBe("TileSet_demo");
    const output = patchTileMapData(document, [{ layer, base64: "AQIDBA==" }]);
    expect(output).toBe(source.replace("PackedByteArray(\"AAAA\")", "PackedByteArray(\"AQIDBA==\")"));
  });
});
