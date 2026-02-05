#!/usr/bin/env node

/**
 * godot-tilemap-mcp – MCP server for Godot 4 TileMapLayer / TileSet inspection and editing.
 *
 * Tools:
 *   READ:  list_tilemaps, inspect_tileset, get_tilemap_info, read_tiles, render_tilemap
 *   WRITE: set_tiles, fill_rect, erase_tiles, erase_rect
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readdir, stat } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { decodeTileData, encodeTileData } from './tileData.js';
import { parseTscn, parseTscnText, findTileMapLayers, updateTileMapData, buildExtResourceMap } from './tscnParser.js';
import { parseTileSet } from './tresParser.js';

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

const PROJECT_PATH = process.env.GODOT_PROJECT_PATH || process.cwd();

function resolvePath(input) {
  if (!input) throw new Error('Path is required');
  // res:// style
  if (input.startsWith('res://')) {
    return path.join(PROJECT_PATH, input.slice(6));
  }
  // Already absolute
  if (path.isAbsolute(input)) return input;
  // Relative to project
  return path.join(PROJECT_PATH, input);
}

// ---------------------------------------------------------------------------
// Recursive file scanner
// ---------------------------------------------------------------------------

async function findFiles(dir, ext) {
  const results = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip hidden dirs and common non-project dirs
      if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '.godot') continue;
      results.push(...await findFiles(full, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tool implementations
// ---------------------------------------------------------------------------

async function toolListTilemaps(args) {
  const projectDir = args.project_path ? resolvePath(args.project_path) : PROJECT_PATH;
  const tscnFiles = await findFiles(projectDir, '.tscn');
  const results = [];

  for (const fp of tscnFiles) {
    // Quick check – read file and look for TileMapLayer before full parsing
    const text = await readFile(fp, 'utf-8');
    if (!text.includes('type="TileMapLayer"')) continue;

    const parsed = parseTscnText(text);
    const layers = findTileMapLayers(parsed);
    if (layers.length === 0) continue;

    const relPath = path.relative(projectDir, fp);
    results.push({
      scene: relPath,
      absolute_path: fp,
      layers: layers.map(l => ({
        name: l.name,
        tile_count: l.tileMapDataB64 ? decodeTileData(l.tileMapDataB64).length : 0,
        has_data: !!l.tileMapDataB64,
        tileset_ref: l.tileSetRef || null,
        z_index: l.zIndex,
        visible: l.visible,
      })),
    });
  }

  return results;
}

async function toolInspectTileset(args) {
  const fp = resolvePath(args.tileset_path);
  return await parseTileSet(fp);
}

async function toolGetTilemapInfo(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layerFilter = args.layer_name;

  const result = [];
  for (const l of layers) {
    if (layerFilter && l.name !== layerFilter) continue;

    const cells = l.tileMapDataB64 ? decodeTileData(l.tileMapDataB64) : [];
    let bounds = null;
    if (cells.length > 0) {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const c of cells) {
        if (c.x < minX) minX = c.x;
        if (c.x > maxX) maxX = c.x;
        if (c.y < minY) minY = c.y;
        if (c.y > maxY) maxY = c.y;
      }
      bounds = { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
    }

    result.push({
      name: l.name,
      tile_count: cells.length,
      bounds,
      tileset_ref: l.tileSetRef || null,
      tileset_ext_id: l.tileSetExtId || null,
      z_index: l.zIndex,
      visible: l.visible,
      position: l.position,
    });
  }

  return result;
}

async function toolReadTiles(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  let cells = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];

  // Apply region filter
  if (args.region) {
    const r = args.region;
    cells = cells.filter(c =>
      c.x >= r.x && c.x < r.x + r.width &&
      c.y >= r.y && c.y < r.y + r.height
    );
  }

  return { layer: layer.name, tile_count: cells.length, tiles: cells };
}

async function toolRenderTilemap(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  let cells = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];
  if (cells.length === 0) return { render: '(empty layer)', bounds: null };

  // Region filter
  if (args.region) {
    const r = args.region;
    cells = cells.filter(c =>
      c.x >= r.x && c.x < r.x + r.width &&
      c.y >= r.y && c.y < r.y + r.height
    );
  }

  if (cells.length === 0) return { render: '(no tiles in region)', bounds: null };

  // Compute bounds
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }

  const width = maxX - minX + 1;
  const height = maxY - minY + 1;

  // Safety cap
  if (width * height > 10000) {
    return {
      render: `(region too large for ASCII: ${width}x${height} = ${width * height} cells. Use a smaller region filter.)`,
      bounds: { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY },
    };
  }

  // Build cell lookup
  const cellMap = new Map();
  for (const c of cells) {
    cellMap.set(`${c.x},${c.y}`, c);
  }

  const mode = args.mode || 'source';
  const lines = [];

  // Header with column numbers
  const colNums = [];
  for (let x = minX; x <= maxX; x++) {
    colNums.push(String(x).padStart(3));
  }
  lines.push('     ' + colNums.join(' '));

  for (let y = minY; y <= maxY; y++) {
    const rowLabel = String(y).padStart(4) + ' ';
    const row = [];
    for (let x = minX; x <= maxX; x++) {
      const c = cellMap.get(`${x},${y}`);
      if (!c) {
        row.push(' . ');
      } else if (mode === 'source') {
        // Source ID as single char: 0-9, A-Z
        const ch = c.source_id < 10 ? String(c.source_id) : String.fromCharCode(55 + c.source_id);
        row.push(` ${ch} `);
      } else if (mode === 'atlas') {
        // Show atlas_x,atlas_y as compact "x.y"
        const label = `${c.atlas_x}.${c.atlas_y}`;
        row.push(label.padStart(3));
      } else {
        // Fallback: source
        const ch = c.source_id < 10 ? String(c.source_id) : String.fromCharCode(55 + c.source_id);
        row.push(` ${ch} `);
      }
    }
    lines.push(rowLabel + row.join(' '));
  }

  return {
    render: lines.join('\n'),
    bounds: { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY },
    tile_count: cells.length,
  };
}

async function toolSetTiles(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  // Decode existing
  const existing = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];

  // Build mutable map
  const cellMap = new Map();
  for (const c of existing) {
    cellMap.set(`${c.x},${c.y}`, c);
  }

  // Apply new tiles
  const newTiles = args.tiles || [];
  for (const t of newTiles) {
    cellMap.set(`${t.x},${t.y}`, {
      x: t.x,
      y: t.y,
      source_id: t.source_id,
      atlas_x: t.atlas_x,
      atlas_y: t.atlas_y,
      alt: t.alt ?? 0,
    });
  }

  const allCells = Array.from(cellMap.values());
  const newB64 = encodeTileData(allCells);
  await updateTileMapData(fp, args.layer_name, newB64);

  return { success: true, total_tiles: allCells.length, tiles_set: newTiles.length };
}

async function toolFillRect(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  const existing = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];
  const cellMap = new Map();
  for (const c of existing) {
    cellMap.set(`${c.x},${c.y}`, c);
  }

  let count = 0;
  for (let y = args.y; y < args.y + args.height; y++) {
    for (let x = args.x; x < args.x + args.width; x++) {
      cellMap.set(`${x},${y}`, {
        x, y,
        source_id: args.source_id,
        atlas_x: args.atlas_x,
        atlas_y: args.atlas_y,
        alt: args.alt ?? 0,
      });
      count++;
    }
  }

  const allCells = Array.from(cellMap.values());
  const newB64 = encodeTileData(allCells);
  await updateTileMapData(fp, args.layer_name, newB64);

  return { success: true, total_tiles: allCells.length, tiles_filled: count };
}

async function toolEraseTiles(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  const existing = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];
  const toErase = new Set((args.positions || []).map(p => `${p.x},${p.y}`));
  const remaining = existing.filter(c => !toErase.has(`${c.x},${c.y}`));

  const newB64 = encodeTileData(remaining);
  await updateTileMapData(fp, args.layer_name, newB64);

  return { success: true, total_tiles: remaining.length, tiles_erased: existing.length - remaining.length };
}

async function toolEraseRect(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === args.layer_name);

  if (!layer) throw new Error(`Layer "${args.layer_name}" not found. Available: ${layers.map(l => l.name).join(', ')}`);

  const existing = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];
  const remaining = existing.filter(c =>
    !(c.x >= args.x && c.x < args.x + args.width &&
      c.y >= args.y && c.y < args.y + args.height)
  );

  const newB64 = encodeTileData(remaining);
  await updateTileMapData(fp, args.layer_name, newB64);

  return { success: true, total_tiles: remaining.length, tiles_erased: existing.length - remaining.length };
}

// ---------------------------------------------------------------------------
// Tool definitions (JSON Schema)
// ---------------------------------------------------------------------------

const TOOL_DEFINITIONS = [
  {
    name: 'list_tilemaps',
    description: 'Scan the Godot project for all .tscn scenes containing TileMapLayer nodes. Returns scene paths, layer names, tile counts, and tileset references.',
    inputSchema: {
      type: 'object',
      properties: {
        project_path: {
          type: 'string',
          description: 'Override project path. Accepts absolute, relative, or res:// paths. Defaults to GODOT_PROJECT_PATH env var.',
        },
      },
    },
  },
  {
    name: 'inspect_tileset',
    description: 'Parse a Godot .tres TileSet resource file and return its full structure: tile_size, atlas sources with tile definitions (custom data, terrain, peering bits), custom data layer names, terrain sets, physics layers.',
    inputSchema: {
      type: 'object',
      properties: {
        tileset_path: {
          type: 'string',
          description: 'Path to the .tres TileSet file. Accepts absolute, relative, or res:// paths.',
        },
      },
      required: ['tileset_path'],
    },
  },
  {
    name: 'get_tilemap_info',
    description: 'Get metadata for TileMapLayer nodes in a .tscn scene: bounds, tile count, tileset reference, z_index, visibility, position. Optionally filter to a single layer.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: {
          type: 'string',
          description: 'Path to the .tscn scene file.',
        },
        layer_name: {
          type: 'string',
          description: 'Optional: filter to a specific layer name.',
        },
      },
      required: ['scene_path'],
    },
  },
  {
    name: 'read_tiles',
    description: 'Decode and return all tiles from a TileMapLayer. Each tile has: x, y, source_id, atlas_x, atlas_y, alt. Optionally filter by rectangular region.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        region: {
          type: 'object',
          description: 'Optional rectangular region filter.',
          properties: {
            x: { type: 'integer', description: 'Left edge (cell X).' },
            y: { type: 'integer', description: 'Top edge (cell Y).' },
            width: { type: 'integer', description: 'Width in cells.' },
            height: { type: 'integer', description: 'Height in cells.' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
      required: ['scene_path', 'layer_name'],
    },
  },
  {
    name: 'render_tilemap',
    description: 'Render a TileMapLayer as ASCII art for quick visualization. Modes: "source" shows source_id per cell (0-9,A-Z), "atlas" shows atlas coords (x.y). Supports region filtering.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        mode: {
          type: 'string',
          enum: ['source', 'atlas'],
          description: 'Display mode. "source" = source ID chars, "atlas" = atlas coordinates. Default: source.',
        },
        region: {
          type: 'object',
          description: 'Optional rectangular region filter.',
          properties: {
            x: { type: 'integer' },
            y: { type: 'integer' },
            width: { type: 'integer' },
            height: { type: 'integer' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
      },
      required: ['scene_path', 'layer_name'],
    },
  },
  {
    name: 'set_tiles',
    description: 'Set (place or overwrite) one or more tiles on a TileMapLayer. Merges with existing data and writes back to the .tscn file.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        tiles: {
          type: 'array',
          description: 'Array of tiles to set.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer', description: 'Cell X coordinate.' },
              y: { type: 'integer', description: 'Cell Y coordinate.' },
              source_id: { type: 'integer', description: 'TileSet source index (0-based).' },
              atlas_x: { type: 'integer', description: 'Atlas X coordinate within the source.' },
              atlas_y: { type: 'integer', description: 'Atlas Y coordinate within the source.' },
              alt: { type: 'integer', description: 'Alternative tile ID (default 0).' },
            },
            required: ['x', 'y', 'source_id', 'atlas_x', 'atlas_y'],
          },
        },
      },
      required: ['scene_path', 'layer_name', 'tiles'],
    },
  },
  {
    name: 'fill_rect',
    description: 'Fill a rectangular region of a TileMapLayer with a single tile type. Overwrites existing tiles in the area.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        x: { type: 'integer', description: 'Left edge (cell X).' },
        y: { type: 'integer', description: 'Top edge (cell Y).' },
        width: { type: 'integer', description: 'Width in cells.' },
        height: { type: 'integer', description: 'Height in cells.' },
        source_id: { type: 'integer', description: 'TileSet source index.' },
        atlas_x: { type: 'integer', description: 'Atlas X coordinate.' },
        atlas_y: { type: 'integer', description: 'Atlas Y coordinate.' },
        alt: { type: 'integer', description: 'Alternative tile ID (default 0).' },
      },
      required: ['scene_path', 'layer_name', 'x', 'y', 'width', 'height', 'source_id', 'atlas_x', 'atlas_y'],
    },
  },
  {
    name: 'erase_tiles',
    description: 'Remove tiles at specific positions from a TileMapLayer.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        positions: {
          type: 'array',
          description: 'Positions to erase.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
            },
            required: ['x', 'y'],
          },
        },
      },
      required: ['scene_path', 'layer_name', 'positions'],
    },
  },
  {
    name: 'erase_rect',
    description: 'Clear all tiles within a rectangular region of a TileMapLayer.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        x: { type: 'integer', description: 'Left edge (cell X).' },
        y: { type: 'integer', description: 'Top edge (cell Y).' },
        width: { type: 'integer', description: 'Width in cells.' },
        height: { type: 'integer', description: 'Height in cells.' },
      },
      required: ['scene_path', 'layer_name', 'x', 'y', 'width', 'height'],
    },
  },
];

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

class GodotTilemapMCPServer {
  constructor() {
    this.server = new Server(
      { name: 'godot-tilemap-mcp', version: '1.0.0' },
      { capabilities: { tools: {} } }
    );
    this.setupHandlers();
    this.setupErrorHandling();
  }

  setupHandlers() {
    // List tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: TOOL_DEFINITIONS,
    }));

    // Call tool
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const { name, arguments: args } = request.params;
      try {
        let result;
        switch (name) {
          case 'list_tilemaps':    result = await toolListTilemaps(args || {}); break;
          case 'inspect_tileset':  result = await toolInspectTileset(args);     break;
          case 'get_tilemap_info': result = await toolGetTilemapInfo(args);     break;
          case 'read_tiles':       result = await toolReadTiles(args);          break;
          case 'render_tilemap':   result = await toolRenderTilemap(args);      break;
          case 'set_tiles':        result = await toolSetTiles(args);           break;
          case 'fill_rect':        result = await toolFillRect(args);           break;
          case 'erase_tiles':      result = await toolEraseTiles(args);         break;
          case 'erase_rect':       result = await toolEraseRect(args);          break;
          default:
            return {
              content: [{ type: 'text', text: `Unknown tool: ${name}` }],
              isError: true,
            };
        }

        // For render_tilemap, return the ASCII art as text
        if (name === 'render_tilemap' && result.render) {
          return {
            content: [{ type: 'text', text: result.render + (result.bounds ? `\n\nBounds: ${JSON.stringify(result.bounds)}  Tiles: ${result.tile_count}` : '') }],
          };
        }

        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return {
          content: [{ type: 'text', text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    });
  }

  setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[godot-tilemap-mcp] Server error:', error);
    };
    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error(`[godot-tilemap-mcp] Running. Project: ${PROJECT_PATH}`);
  }
}

const server = new GodotTilemapMCPServer();
server.run().catch(console.error);
