# godot-tilemap-mcp

Give AI agents eyes, vocabulary, and a safe paintbrush for Godot 4 tilemaps.

`godot-tilemap-mcp` is a focused TileMapLayer toolkit exposed both as an MCP server and a command-line application. It understands the binary `tile_map_data` hidden inside Godot text scenes, builds a semantic catalog from TileSets, renders actual atlas textures, analyzes map quality, and applies deterministic edits through reviewable transactions.

It is designed for agents, but the CLI, PNG reports, JSON recipes, and lossless core are equally useful in human-authored pipelines.

## What v2 changes

- Visual output: map PNGs, tile contact sheets, and before/after/diff reports.
- Semantic discovery: aliases, terrain metadata, custom data, physics, navigation, atlas alternatives, animations, and scene sources.
- Safe editing: preview first, revision lock, atomic write, surgical `tile_map_data` patch, and guarded undo.
- Deterministic authoring: shapes, paths, scatter, stamps, copy/transform, replace, flood fill, and Godot-native terrain connection.
- Embedded TileSets: external `.tres` files and `TileSet` subresources inside `.tscn` are both inspectable.
- Worktree-aware paths: explicit project overrides and allow-listed roots prevent accidental writes to the wrong checkout.
- Reusable library: the parser, codec, catalog, renderer, analyzer, recipe engine, and transaction store are exported as typed modules.
- v1 compatibility: all old MCP tool names remain; legacy write calls now create previews unless direct mode is explicitly enabled.

## Requirements

- Node.js 22 or newer.
- A Godot 4 project using `TileMapLayer` nodes in text `.tscn` scenes.
- A Godot executable only for terrain-connect operations. Static inspection, ordinary edits, analysis, and atlas rendering do not launch Godot.

## Install from source

```bash
git clone https://github.com/Ekaitzsegurola/godot-tilemap-mcp.git
cd godot-tilemap-mcp
npm install
npm run build
```

The package exposes `godot-tilemap-mcp`, and the old `node src/index.js` entrypoint remains as a compatibility shim after building.

## MCP configuration

```json
{
  "mcpServers": {
    "godot-tilemap": {
      "command": "node",
      "args": [
        "/absolute/path/to/godot-tilemap-mcp/dist/cli.js",
        "mcp",
        "--project",
        "/absolute/path/to/game"
      ]
    }
  }
}
```

For repositories with agent worktrees, allow their common parent and pass an absolute `project_path` with each call:

```json
"args": [
  "/absolute/path/to/godot-tilemap-mcp/dist/cli.js",
  "mcp",
  "--project", "/projects/game",
  "--allow-root", "/projects/game-worktrees"
]
```

The server rejects project overrides outside its configured roots.

## The safe edit flow

An edit is never just “write these bytes.” It is a recipe tied to an exact scene revision:

1. `preview_tilemap_edit` validates coordinates, layers, TileSet references, aliases, limits, and protected layers.
2. It calculates the cell-level diff and stores `before.png`, `after.png`, `diff.png`, and `report.html` outside the project.
3. `apply_tilemap_edit` checks that the scene still has the same SHA-256 revision, patches only the affected `tile_map_data` properties, and writes atomically.
4. `undo_tilemap_edit` restores the original bytes only if no later change touched the scene.

This makes previews useful in chat while avoiding stale-agent overwrites.

```json
{
  "recipe": {
    "scenePath": "res://Scenes/World.tscn",
    "seed": "village-square-v1",
    "operations": [
      {
        "op": "path",
        "layer": "World/Ground",
        "points": [{ "x": 4, "y": 9 }, { "x": 18, "y": 9 }, { "x": 24, "y": 14 }],
        "width": 3,
        "tile": { "brush": "dirt_path" }
      },
      {
        "op": "scatter",
        "layer": "World/Details",
        "region": { "x": 2, "y": 5, "width": 28, "height": 16 },
        "density": 0.08,
        "minDistance": 2,
        "tile": { "brush": "wildflowers" }
      }
    ]
  }
}
```

Recipes are deterministic: the same starting revision, recipe, and seed produce the same bytes.

## MCP tools

### Project and discovery

| Tool | Purpose |
| --- | --- |
| `tilemap_doctor` | Diagnose project/profile discovery, bridge availability, scenes, data, and references |
| `list_tilemaps` | Find scenes and report layers, counts, bounds, and TileSets |
| `inspect_tilemap` | Inspect scene revision, layers, cells, and semantic TileSet summaries |
| `inspect_tileset` | Catalog an external or embedded TileSet |
| `find_tiles` | Search by text, source, terrain, custom data, physics, or navigation; returns a contact sheet |
| `read_tiles` | Decode cells, with region and response limits |

### Seeing and understanding maps

| Tool | Purpose |
| --- | --- |
| `render_tilemap_image` | Render visible layers from their atlas textures as PNG |
| `analyze_tilemap` | Measure variety, entropy, repetition, runs, topology, isolated cells, and invalid references |
| `extract_tilemap_pattern` | Turn an authored region into a reusable ASCII stamp and palette |

### Transactional authoring

| Tool | Purpose |
| --- | --- |
| `preview_tilemap_edit` | Validate a recipe and return a visual, revision-locked diff |
| `apply_tilemap_edit` | Apply an existing preview atomically |
| `undo_tilemap_edit` | Undo when the post-apply revision still matches |
| `discard_tilemap_edit` | Remove cached artifacts for unapplied/undone work |

Supported operations are `set`, `erase`, `fill`, `flood_fill`, `path`, `scatter`, `replace`, `stamp`, `copy`, `terrain_connect`, and `terrain_path`.

The v1 tools `get_tilemap_info`, `render_tilemap`, `analyze_tilemap_patterns`, `set_tiles`, `fill_rect`, `paint_path`, `stamp_pattern`, `erase_tiles`, and `erase_rect` are also registered. Old write tools are preview-only by default. `--legacy-direct-writes` restores immediate application for controlled migrations.

## CLI

```bash
godot-tilemap-mcp doctor --project /path/to/game
godot-tilemap-mcp list --project /path/to/game
godot-tilemap-mcp inspect res://Scenes/World.tscn --layer World/Ground
godot-tilemap-mcp catalog res://Tiles/world.tres --text grass --out /tmp/grass.png
godot-tilemap-mcp render res://Scenes/World.tscn --layer World/Ground --out /tmp/world.png --grid
godot-tilemap-mcp analyze res://Scenes/World.tscn --layer World/Ground
godot-tilemap-mcp plan recipes/new-grove.json
godot-tilemap-mcp apply tx_...
godot-tilemap-mcp undo tx_...
```

Run `godot-tilemap-mcp help` for all options.

## Optional project profile

The semantic catalog works automatically. A `.godot-tilemap-mcp.json` profile adds project language and guardrails:

```json
{
  "$schema": "https://raw.githubusercontent.com/Ekaitzsegurola/godot-tilemap-mcp/main/schemas/project-profile.schema.json",
  "version": 1,
  "layer_roles": {
    "ground": ["*/Ground", "*/Base"],
    "details": ["*/Details", "*/Overlay"]
  },
  "protected_layers": ["*/RuntimeMarkers"],
  "tilesets": {
    "res://Tiles/world.tres": {
      "aliases": {
        "grass_base": { "source_id": 0, "atlas_x": 2, "atlas_y": 4, "alternative_id": 0 }
      },
      "brushes": {
        "wildflowers": {
          "tiles": [
            { "tile": { "alias": "flower_blue" }, "weight": 3 },
            { "tile": { "alias": "flower_white" }, "weight": 1 }
          ]
        }
      }
    }
  },
  "limits": {
    "max_cells_per_edit": 50000,
    "max_render_pixels": 16777216
  }
}
```

Create a starter profile with `godot-tilemap-mcp config init`. See [Recipes and profiles](docs/RECIPES.md) for the complete workflow.

## Lossless editing and binary format

The core parses Godot text resources with byte offsets and preserves every untouched character, including line endings and a UTF-8 BOM. Applying a transaction replaces only complete `tile_map_data` property lines.

Godot 4 stores the field as base64 for this layout:

```text
uint16 LE format version
repeat:
  int16  LE cell x
  int16  LE cell y
  uint16 LE source id
  uint16 LE atlas x
  uint16 LE atlas y
  uint16 LE alternative/transform flags
```

Malformed base64, truncated payloads, invalid ranges, ambiguous layer names, unknown tile references, stale revisions, protected layers, and oversized edits fail before a scene write.

## Library API

```ts
import {
  ProjectPaths,
  TransactionStore,
  inspectTileSet,
  loadSceneSnapshot,
  renderSceneImage,
} from "godot-tilemap-mcp/core";
```

The core has no dependency on MCP transport. See [Architecture](docs/ARCHITECTURE.md) for module boundaries and extension points.

## Security and privacy

The runtime does not call cloud services. It reads only allow-listed local Godot projects, renders local assets, stores previews in the operating system cache, and invokes a local Godot executable only for operations that need engine semantics. Review [SECURITY.md](SECURITY.md) before exposing it beyond a local stdio client.

## Contributing

Bug reports, TileSet fixtures, platform feedback, and focused pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT — see [LICENSE](LICENSE).
