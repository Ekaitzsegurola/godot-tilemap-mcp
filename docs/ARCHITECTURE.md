# Architecture

`godot-tilemap-mcp` has one typed core and two thin delivery layers.

```text
MCP server ─┐
            ├─ public core ─ codec / Godot text / TileSet catalog
CLI ────────┘              ├─ analysis / rendering / recipes
                           └─ transaction store ─ optional Godot bridge
```

## Core boundaries

- `tileData.ts` is the strict codec for Godot 4 `TileMapLayer.tile_map_data`. It preserves the two-byte format header and rejects malformed lengths and out-of-range values.
- `godotText.ts` indexes sections and properties by source offsets. It supports external and embedded TileSets and patches complete property lines without serializing the rest of a scene.
- `tileset.ts` statically catalogs atlas and scene sources, custom data layers, terrain sets and peering bits, probabilities, animations, physics, navigation, margins, separation, and atlas alternatives.
- `paths.ts` discovers owning Godot projects and enforces allow-listed roots. An absolute scene in an allowed worktree resolves against that worktree, not the server's default project.
- `project.ts` assembles immutable scene/layer snapshots and SHA-256 revisions.
- `analyze.ts` provides pure catalog search, pattern extraction, and structural quality metrics.
- `render.ts` uses local atlas textures through Sharp. Missing/non-atlas tiles receive visible deterministic placeholders instead of silently disappearing.
- `edit.ts` evaluates deterministic operations in memory and calculates cell-level diffs. It has no filesystem write authority.
- `transactions.ts` owns preview persistence, revision checks, locks, atomic application, and guarded undo.
- `bridge.ts` invokes `bridge/godot_tilemap_bridge.gd` as a one-shot headless process for behavior that should remain Godot-native, currently terrain connection and map-coordinate conversion.
- `profile.ts` adds optional project vocabulary and policy without making profiles necessary for basic use.

`core/index.ts` is the public package boundary. Other tools should depend on it instead of copying the binary codec or Godot parsers.

## Transaction invariants

1. A recipe is validated against an immutable scene snapshot.
2. A preview records the exact base revision and original/next packed data for each changed layer.
3. Preview artifacts live outside the project under the OS cache directory.
4. Apply acquires a per-scene lock and compares the current revision to the preview revision.
5. Only `tile_map_data` lines are patched; all other text remains byte-for-byte identical.
6. The replacement is written to a sibling temporary file, synchronized, permission-matched, and atomically renamed.
7. Undo is accepted only when the current revision equals the transaction's post-apply revision.

These invariants deliberately make stale work fail rather than merge opaque tile bytes.

## Static parser versus Godot bridge

Static parsing is fast, reviewable, and works without importing a project. It is preferred for inspection, ordinary cell edits, catalog search, analysis, and rendering.

Terrain connectivity depends on Godot's TileSet algorithms. Reimplementing that behavior would create version drift, so `terrain_connect` and `terrain_path` instantiate the target scene in a local headless Godot process, call `set_cells_terrain_connect`/`set_cells_terrain_path`, and return the resulting cells to the ordinary transaction pipeline. The bridge never writes the scene itself.

## Extension points

- Add pure recipe operations in `edit.ts` and their Zod wire schema in `schema.ts`.
- Add engine-backed operations to the `TerrainBridge`-style boundary and the one-shot GDScript request protocol.
- Put project-specific data under the profile's `extensions` object; core parsing preserves it.
- Consumers needing domain semantics should map generic `CatalogTile.customData` by layer name, not fork the TileSet parser.

## Non-goals

- Replacing the Godot editor.
- Parsing or rewriting arbitrary binary `.scn` resources.
- Becoming a general Godot MCP server unrelated to tilemaps.
- Guessing game-specific meaning when neither TileSet metadata nor an optional profile supplies it.
