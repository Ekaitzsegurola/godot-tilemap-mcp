# godot-tilemap-mcp

MCP (Model Context Protocol) server that lets AI agents **read, inspect, visualize, and draw** on Godot 4 TileMapLayer / TileSet resources.

AI coding assistants (Cursor, Codex, Claude, etc.) can't normally see tilemap data — it's stored as opaque binary inside `.tscn` files. This server decodes it and exposes 9 tools so the AI can understand your maps and edit them programmatically.

## Tools

### Inspection (read-only)

| Tool | Description |
|---|---|
| `list_tilemaps` | Scan the project for all `.tscn` scenes containing TileMapLayer nodes |
| `inspect_tileset` | Parse a `.tres` TileSet: sources, custom data layers, terrains, physics |
| `get_tilemap_info` | Bounds, tile count, tileset ref, z_index, visibility per layer |
| `read_tiles` | Decode all tiles from a layer (with optional region filter) |
| `render_tilemap` | ASCII art visualization — source IDs or atlas coordinates |

### Drawing (write)

| Tool | Description |
|---|---|
| `set_tiles` | Place or overwrite tiles at specific coordinates |
| `fill_rect` | Fill a rectangular region with a single tile type |
| `erase_tiles` | Remove tiles at specific positions |
| `erase_rect` | Clear all tiles in a rectangular region |

## Quick start

```bash
cd godot-tilemap-mcp
npm install
```

### Cursor

Add to `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "godot-tilemap": {
      "command": "node",
      "args": ["/absolute/path/to/godot-tilemap-mcp/src/index.js"],
      "env": {
        "GODOT_PROJECT_PATH": "/absolute/path/to/your/godot/project"
      }
    }
  }
}
```

### Codex / other MCP clients

Any MCP client that supports stdio transport can use this server. Set the `GODOT_PROJECT_PATH` environment variable to your Godot project root and run:

```bash
GODOT_PROJECT_PATH=/path/to/project node src/index.js
```

## Path resolution

All tools accept paths in three forms:

- **Absolute**: `/home/user/project/Scenes/World.tscn`
- **Relative**: `Scenes/World.tscn` (from `GODOT_PROJECT_PATH`)
- **Godot-style**: `res://Scenes/World.tscn` (strips `res://`, joins with project path)

## Binary format

Godot 4's `tile_map_data` is a `PackedByteArray` stored as base64 in `.tscn` text scenes:

```
Header (2 bytes):
  uint16 LE  format version

Per cell (12 bytes):
  int16  LE  cell X
  int16  LE  cell Y
  uint16 LE  source_id
  uint16 LE  atlas_coords.x
  uint16 LE  atlas_coords.y
  uint16 LE  alternative_tile
```

Reference: [`godotengine/godot` — `scene/2d/tile_map_layer.cpp`](https://github.com/godotengine/godot/blob/master/scene/2d/tile_map_layer.cpp)

## Example usage (by AI)

Once configured, an AI agent can:

```
> list_tilemaps
4 scenes found. World.tscn has layers: Base (258 tiles), Overlay (12 tiles)...

> render_tilemap scene:World.tscn layer:TileMapLayer_Base mode:source
      -4  -3  -2  -1   0   1   2   3   4   5
  0    1   1   1   1   1   1   1   1   1   1
  1    1   1   1   1   1   1   1   1   1   1
  2    1   1   1   1   0   0   0   1   1   1
  ...

> set_tiles scene:World.tscn layer:TileMapLayer_Base tiles:[{x:5,y:3,source_id:2,atlas_x:1,atlas_y:0}]
Success: 1 tile set, 259 total
```

## Requirements

- Node.js 18+
- A Godot 4.x project with `.tscn` scenes using TileMapLayer nodes

## License

MIT
