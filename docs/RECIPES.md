# Recipes and profiles

Recipes describe intent without granting immediate write access. Coordinates are TileMap cell coordinates and every operation names one path-qualified `TileMapLayer`.

## Recipe envelope

```json
{
  "scenePath": "res://Scenes/World.tscn",
  "projectPath": "/optional/absolute/worktree",
  "seed": "stable-authoring-seed",
  "expectedRevision": "optional-64-character-sha256",
  "operations": []
}
```

`projectPath` is especially important when one server is shared by several worktrees. The path must be inside a root configured with `--allow-root`.

If `seed` is absent, the engine derives one from the base revision and operations. Supplying a human-readable seed makes later intentional regeneration easier.

## Tile selectors

Operations accept one of three selector forms:

```json
{ "sourceId": 0, "atlasX": 4, "atlasY": 2, "alternativeId": 0 }
{ "alias": "grass_edge_north" }
{ "brush": "meadow_details" }
```

Raw references are validated against the target layer's TileSet. Auto-generated aliases come from source/texture names and atlas coordinates. Profile aliases provide stable project vocabulary. Brushes choose among weighted selectors deterministically.

## Operations

### Set exact cells

```json
{
  "op": "set",
  "layer": "World/Details",
  "cells": [
    { "x": 10, "y": 8, "tile": { "alias": "signpost" } },
    { "x": 16, "y": 11, "tile": { "brush": "small_rocks" } }
  ]
}
```

### Fill or erase shapes

Shapes can be rectangles, ellipses, polygons, or explicit cells.

```json
{
  "op": "fill",
  "layer": "World/Ground",
  "shape": { "kind": "ellipse", "x": 4, "y": 6, "width": 13, "height": 9 },
  "tile": { "brush": "meadow" }
}
```

```json
{
  "op": "erase",
  "layer": "World/Details",
  "shape": {
    "kind": "polygon",
    "points": [{ "x": 2, "y": 2 }, { "x": 8, "y": 4 }, { "x": 5, "y": 10 }]
  }
}
```

### Flood fill

```json
{
  "op": "flood_fill",
  "layer": "World/Ground",
  "start": { "x": 12, "y": 12 },
  "tile": { "alias": "sand" },
  "maxCells": 5000
}
```

The safety cap prevents an empty-space fill from becoming unbounded.

### Authored path

```json
{
  "op": "path",
  "layer": "World/Ground",
  "points": [{ "x": 2, "y": 7 }, { "x": 12, "y": 9 }, { "x": 20, "y": 4 }],
  "width": 3,
  "jitter": 1,
  "tile": { "brush": "dirt_path" }
}
```

### Scatter with spacing

```json
{
  "op": "scatter",
  "layer": "World/Details",
  "region": { "x": 0, "y": 0, "width": 32, "height": 24 },
  "density": 0.12,
  "minDistance": 2,
  "tile": { "brush": "forest_floor" }
}
```

### Replace in a region

```json
{
  "op": "replace",
  "layer": "World/Ground",
  "region": { "x": 0, "y": 0, "width": 20, "height": 20 },
  "from": { "alias": "grass_plain" },
  "to": { "brush": "grass_varied" }
}
```

### Stamp a reusable landmark

```json
{
  "op": "stamp",
  "layer": "World/Details",
  "origin": { "x": 30, "y": 14 },
  "pattern": [
    "..T..",
    ".R.R.",
    "R...R",
    ".RRR."
  ],
  "palette": {
    "T": { "alias": "ruin_pillar" },
    "R": { "brush": "ruin_stone" }
  }
}
```

Use `extract_tilemap_pattern` to derive the pattern and palette from a region already authored in Godot.

### Copy and transform

```json
{
  "op": "copy",
  "layer": "World/Details",
  "source": { "x": 4, "y": 4, "width": 8, "height": 6 },
  "destination": { "x": 24, "y": 4 },
  "flipX": true,
  "rotate": 0
}
```

### Godot-native terrains

```json
{
  "op": "terrain_connect",
  "layer": "World/Ground",
  "cells": [{ "x": 4, "y": 4 }, { "x": 5, "y": 4 }, { "x": 6, "y": 4 }],
  "terrainSet": 0,
  "terrain": 1,
  "ignoreEmptyTerrains": true
}
```

`terrain_path` takes polyline `points` instead of `cells`. Both require a local Godot executable and still return through the same preview transaction.

## Project profile

The profile uses snake_case because it is a stable repository data format. Tile references inside it use `source_id`, `atlas_x`, `atlas_y`, and `alternative_id`; recipe references use the TypeScript-style names shown above.

Layer role values and `protected_layers` accept `*` wildcards. Protected layers fail during planning, before preview files or scene writes.

Tileset profile keys are labels for organization; aliases are currently merged into the project's shared vocabulary. Give aliases globally unique names when several TileSets are present.

The `analysis` block can name custom-data layers used for walk masks or forced blocking. The analyzer then verifies those layers exist in inspected TileSets. Domain-specific consumers can place additional configuration under `extensions`.

## Review checklist

- Use a path-qualified layer when names repeat.
- Prefer semantic aliases or brushes after discovering tiles with `find_tiles`.
- Crop large renders and previews to the intended area.
- Review the cell diff and `diff.png` before apply.
- Apply the exact returned transaction; do not regenerate it after review.
- If apply reports a stale revision, inspect the new map state and create a new preview.
