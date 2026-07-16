# Changelog

All notable changes to this project are documented here.

## 2.0.0 — 2026-07-16

### Added

- TypeScript public core and CLI package entrypoint.
- Lossless Godot text parser with external and embedded TileSet support.
- Strict `tile_map_data` codec that preserves the Godot format header.
- Semantic TileSet catalog, tile search, and PNG contact sheets.
- Real-atlas TileMap rendering and visual edit reports.
- Structural map analysis and reusable pattern extraction.
- Deterministic recipes for shapes, paths, scatter, replace, stamps, transforms, flood fill, and terrains.
- Revision-locked preview/apply/undo transactions with atomic surgical writes.
- Optional project profiles for aliases, brushes, layer roles, protected layers, analysis semantics, and safety limits.
- Local headless-Godot bridge for terrain algorithms.
- Worktree-aware project overrides and allow-listed roots.
- MCP annotations, structured results, image content, and diagnostic tools.

### Changed

- Legacy write tools create previews by default. Immediate behavior is available only with `--legacy-direct-writes`.
- Runtime baseline is Node.js 22.
- MCP SDK upgraded from the early 0.x API to the current 1.x high-level server API.

### Compatibility

- All v1 MCP tool names remain registered.
- `src/index.js` remains as a post-build compatibility entrypoint.
- Legacy binary codec aliases remain exported from `godot-tilemap-mcp/core`.

## 1.0.0

- Initial MCP server for listing, inspecting, reading, ASCII-rendering, and directly editing Godot 4 TileMapLayer data.
