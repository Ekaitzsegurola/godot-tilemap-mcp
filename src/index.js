#!/usr/bin/env node

/**
 * godot-tilemap-mcp – MCP server for Godot 4 TileMapLayer / TileSet inspection and editing.
 *
 * Tools:
 *   READ:  list_tilemaps, inspect_tileset, get_tilemap_info, read_tiles, render_tilemap
 *   ANALYZE: analyze_tilemap_patterns
 *   WRITE: set_tiles, fill_rect, erase_tiles, erase_rect, paint_path, stamp_pattern
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
import { parseTscn, parseTscnText, findTileMapLayers, updateTileMapData, buildExtResourceMap, resolveLayer } from './tscnParser.js';
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
// Tile editing helpers
// ---------------------------------------------------------------------------

function cellKey(x, y) {
  return `${x},${y}`;
}

async function loadLayerCells(scenePath, layerName) {
  const fp = resolvePath(scenePath);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = resolveLayer(layers, layerName);
  const cells = layer.tileMapDataB64 ? decodeTileData(layer.tileMapDataB64) : [];
  const cellMap = new Map();
  for (const cell of cells) {
    cellMap.set(cellKey(cell.x, cell.y), { ...cell });
  }

  return { fp, layer, cells, cellMap };
}

async function writeLayerCells(fp, layerName, cellMap) {
  const allCells = Array.from(cellMap.values()).sort((a, b) => (a.y - b.y) || (a.x - b.x));
  const newB64 = encodeTileData(allCells);
  await updateTileMapData(fp, layerName, newB64);
  return allCells;
}

function tileFromArgs(args, prefix = '') {
  return {
    source_id: args[`${prefix}source_id`] ?? 0,
    atlas_x: args[`${prefix}atlas_x`],
    atlas_y: args[`${prefix}atlas_y`],
    alt: args[`${prefix}alt`] ?? 0,
  };
}

function putTile(cellMap, x, y, tile) {
  cellMap.set(cellKey(x, y), {
    x,
    y,
    source_id: tile.source_id,
    atlas_x: tile.atlas_x,
    atlas_y: tile.atlas_y,
    alt: tile.alt ?? 0,
  });
}

function seededRandom(seedText = 'level-design') {
  let seed = 2166136261;
  for (let i = 0; i < seedText.length; i++) {
    seed ^= seedText.charCodeAt(i);
    seed = Math.imul(seed, 16777619);
  }

  return () => {
    seed += 0x6D2B79F5;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function normalizePoints(points) {
  if (!Array.isArray(points) || points.length < 2) {
    throw new Error('points must contain at least two {x,y} entries');
  }

  return points.map((p, index) => {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
      throw new Error(`Invalid point at index ${index}; expected numeric x/y`);
    }
    return { x: Number(p.x), y: Number(p.y) };
  });
}

function boundsForCells(cells) {
  if (cells.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const c of cells) {
    if (c.x < minX) minX = c.x;
    if (c.x > maxX) maxX = c.x;
    if (c.y < minY) minY = c.y;
    if (c.y > maxY) maxY = c.y;
  }
  return { min_x: minX, max_x: maxX, min_y: minY, max_y: maxY, width: maxX - minX + 1, height: maxY - minY + 1 };
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
        parent: l.parent || null,
        full_path: l.parent ? `${l.parent}/${l.name}` : l.name,
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

  // If a filter is given, try resolveLayer first (supports path-qualified names)
  const filteredLayers = layerFilter ? [resolveLayer(layers, layerFilter)] : layers;

  const result = [];
  for (const l of filteredLayers) {
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
      parent: l.parent || null,
      full_path: l.parent ? `${l.parent}/${l.name}` : l.name,
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
  const layer = resolveLayer(layers, args.layer_name);

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
  const layer = resolveLayer(layers, args.layer_name);

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

async function toolAnalyzeTilemapPatterns(args) {
  const { cells } = await loadLayerCells(args.scene_path, args.layer_name);
  let analysisCells = cells;
  if (args.region) {
    const r = args.region;
    analysisCells = analysisCells.filter(c =>
      c.x >= r.x && c.x < r.x + r.width &&
      c.y >= r.y && c.y < r.y + r.height
    );
  }

  const bounds = boundsForCells(analysisCells);
  if (!bounds) {
    return { tile_count: 0, bounds: null, warnings: ['No tiles in layer/region.'] };
  }

  const cellMap = new Map();
  const distribution = new Map();
  for (const c of analysisCells) {
    cellMap.set(cellKey(c.x, c.y), c);
    const key = `${c.source_id}:${c.atlas_x}:${c.atlas_y}:${c.alt}`;
    distribution.set(key, (distribution.get(key) || 0) + 1);
  }

  const rows = [];
  const columns = [];
  let horizontalRuns = [];
  let verticalRuns = [];
  let diagonalStreaks = [];

  for (let y = bounds.min_y; y <= bounds.max_y; y++) {
    let row = '';
    let current = null;
    let runStart = bounds.min_x;
    let runLen = 0;
    for (let x = bounds.min_x; x <= bounds.max_x; x++) {
      const c = cellMap.get(cellKey(x, y));
      const value = c ? `${c.atlas_x}.${c.atlas_y}` : '..';
      row += `${value}|`;
      if (value !== current) {
        if (current !== null && runLen >= 6) {
          horizontalRuns.push({ tile: current, y, x: runStart, length: runLen });
        }
        current = value;
        runStart = x;
        runLen = 1;
      } else {
        runLen++;
      }
    }
    if (current !== null && runLen >= 6) {
      horizontalRuns.push({ tile: current, y, x: runStart, length: runLen });
    }
    rows.push(row);
  }

  for (let x = bounds.min_x; x <= bounds.max_x; x++) {
    let column = '';
    let current = null;
    let runStart = bounds.min_y;
    let runLen = 0;
    for (let y = bounds.min_y; y <= bounds.max_y; y++) {
      const c = cellMap.get(cellKey(x, y));
      const value = c ? `${c.atlas_x}.${c.atlas_y}` : '..';
      column += `${value}|`;
      if (value !== current) {
        if (current !== null && runLen >= 6) {
          verticalRuns.push({ tile: current, x, y: runStart, length: runLen });
        }
        current = value;
        runStart = y;
        runLen = 1;
      } else {
        runLen++;
      }
    }
    if (current !== null && runLen >= 6) {
      verticalRuns.push({ tile: current, x, y: runStart, length: runLen });
    }
    columns.push(column);
  }

  const rowCounts = new Map();
  rows.forEach(row => rowCounts.set(row, (rowCounts.get(row) || 0) + 1));
  const repeatedRows = Array.from(rowCounts.values()).filter(count => count > 1).reduce((sum, count) => sum + count, 0);
  const columnCounts = new Map();
  columns.forEach(column => columnCounts.set(column, (columnCounts.get(column) || 0) + 1));
  const repeatedColumns = Array.from(columnCounts.values()).filter(count => count > 1).reduce((sum, count) => sum + count, 0);

  for (let d = bounds.min_x - bounds.max_y; d <= bounds.max_x - bounds.min_y; d++) {
    let streak = [];
    for (let y = bounds.min_y; y <= bounds.max_y; y++) {
      const x = y + d;
      const c = cellMap.get(cellKey(x, y));
      const value = c ? `${c.atlas_x}.${c.atlas_y}` : '..';
      if (value === '1.0') {
        streak.push({ x, y });
      } else {
        if (streak.length >= 5) diagonalStreaks.push({ tile: '1.0', points: streak });
        streak = [];
      }
    }
    if (streak.length >= 5) diagonalStreaks.push({ tile: '1.0', points: streak });
  }

  horizontalRuns = horizontalRuns.sort((a, b) => b.length - a.length).slice(0, 20);
  verticalRuns = verticalRuns.sort((a, b) => b.length - a.length).slice(0, 20);
  diagonalStreaks = diagonalStreaks.sort((a, b) => b.points.length - a.points.length).slice(0, 20);

  const warnings = [];
  if (repeatedRows / rows.length > 0.3) warnings.push('High repeated-row ratio; map may read as patterned or stamped.');
  if (repeatedColumns / columns.length > 0.3) warnings.push('High repeated-column ratio; map may read as patterned or stamped.');
  if (diagonalStreaks.length > 0) warnings.push('Long diagonal streaks detected; replace with clustered/noisy accents.');
  if (horizontalRuns.some(r => r.length >= Math.max(12, bounds.width * 0.4))) warnings.push('Very long horizontal runs detected; break with intersections, landmarks or edge variation.');
  if (verticalRuns.some(r => r.length >= Math.max(10, bounds.height * 0.4))) warnings.push('Very long vertical runs detected; break with bends, pockets or landmarks.');

  return {
    tile_count: analysisCells.length,
    bounds,
    tile_distribution: Array.from(distribution.entries())
      .map(([tile, count]) => ({ tile, count, ratio: Number((count / analysisCells.length).toFixed(4)) }))
      .sort((a, b) => b.count - a.count),
    repeated_rows: { count: repeatedRows, ratio: Number((repeatedRows / rows.length).toFixed(4)) },
    repeated_columns: { count: repeatedColumns, ratio: Number((repeatedColumns / columns.length).toFixed(4)) },
    longest_horizontal_runs: horizontalRuns,
    longest_vertical_runs: verticalRuns,
    diagonal_streaks: diagonalStreaks.map(s => ({ tile: s.tile, length: s.points.length, start: s.points[0], end: s.points[s.points.length - 1] })),
    warnings,
  };
}

async function toolPaintPath(args) {
  const { fp, cellMap } = await loadLayerCells(args.scene_path, args.layer_name);
  const points = normalizePoints(args.points);
  const tile = tileFromArgs(args);
  const width = Math.max(1, args.width ?? 1);
  const radius = Math.max(0, Math.floor((width - 1) / 2));
  const jitter = Math.max(0, args.jitter ?? 0);
  const rng = seededRandom(args.seed ?? JSON.stringify(points));
  const painted = new Set();

  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const steps = Math.max(Math.abs(dx), Math.abs(dy), 1);
    for (let step = 0; step <= steps; step++) {
      const t = step / steps;
      let cx = Math.round(a.x + dx * t);
      let cy = Math.round(a.y + dy * t);
      if (jitter > 0 && step !== 0 && step !== steps) {
        cx += Math.round((rng() * 2 - 1) * jitter);
        cy += Math.round((rng() * 2 - 1) * jitter);
      }

      for (let yy = cy - radius; yy <= cy + radius; yy++) {
        for (let xx = cx - radius; xx <= cx + radius; xx++) {
          const dist = Math.abs(xx - cx) + Math.abs(yy - cy);
          if (dist > radius + (width % 2 === 0 ? 1 : 0)) continue;
          putTile(cellMap, xx, yy, tile);
          painted.add(cellKey(xx, yy));
        }
      }
    }
  }

  const allCells = await writeLayerCells(fp, args.layer_name, cellMap);
  return { success: true, total_tiles: allCells.length, tiles_painted: painted.size };
}

async function toolStampPattern(args) {
  const { fp, cellMap } = await loadLayerCells(args.scene_path, args.layer_name);
  if (!Array.isArray(args.pattern) || args.pattern.length === 0) {
    throw new Error('pattern must be a non-empty array of strings');
  }

  const palette = args.palette || {};
  const originX = args.x ?? 0;
  const originY = args.y ?? 0;
  let count = 0;
  for (let row = 0; row < args.pattern.length; row++) {
    const line = args.pattern[row];
    for (let col = 0; col < line.length; col++) {
      const ch = line[col];
      if (ch === ' ' || ch === '.') continue;
      const tile = palette[ch];
      if (!tile) continue;
      putTile(cellMap, originX + col, originY + row, {
        source_id: tile.source_id ?? 0,
        atlas_x: tile.atlas_x,
        atlas_y: tile.atlas_y,
        alt: tile.alt ?? 0,
      });
      count++;
    }
  }

  const allCells = await writeLayerCells(fp, args.layer_name, cellMap);
  return { success: true, total_tiles: allCells.length, tiles_stamped: count };
}

async function toolSetTiles(args) {
  const fp = resolvePath(args.scene_path);
  const parsed = await parseTscn(fp);
  const layers = findTileMapLayers(parsed);
  const layer = resolveLayer(layers, args.layer_name);

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
  const layer = resolveLayer(layers, args.layer_name);

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
  const layer = resolveLayer(layers, args.layer_name);

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
  const layer = resolveLayer(layers, args.layer_name);

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
          description: 'Optional: filter to a specific layer name. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension when names are duplicated across dimensions.',
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
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
    name: 'analyze_tilemap_patterns',
    description: 'Analyze tile distribution and repetition risks: repeated rows/columns, long runs, and diagonal streaks that make maps look procedurally stamped.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
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
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
    name: 'paint_path',
    description: 'Paint an organic path/polyline between points on a TileMapLayer. Supports width, deterministic jitter, and a target tile.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        points: {
          type: 'array',
          description: 'Polyline control points in tile coordinates.',
          items: {
            type: 'object',
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
            },
            required: ['x', 'y'],
          },
        },
        width: { type: 'integer', description: 'Path width in tiles. Default 1.' },
        jitter: { type: 'number', description: 'Max per-step random tile offset for less rigid paths. Default 0.' },
        seed: { type: 'string', description: 'Optional deterministic seed.' },
        source_id: { type: 'integer', description: 'TileSet source index.' },
        atlas_x: { type: 'integer', description: 'Atlas X coordinate.' },
        atlas_y: { type: 'integer', description: 'Atlas Y coordinate.' },
        alt: { type: 'integer', description: 'Alternative tile ID (default 0).' },
      },
      required: ['scene_path', 'layer_name', 'points', 'source_id', 'atlas_x', 'atlas_y'],
    },
  },
  {
    name: 'stamp_pattern',
    description: 'Stamp an ASCII pattern onto a TileMapLayer using a character-to-tile palette. Useful for plazas, ruins, groves, camps, and other authored landmarks.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node.' },
        x: { type: 'integer', description: 'Pattern origin X.' },
        y: { type: 'integer', description: 'Pattern origin Y.' },
        pattern: {
          type: 'array',
          description: 'Array of strings. Space/dot means transparent.',
          items: { type: 'string' },
        },
        palette: {
          type: 'object',
          description: 'Map of character to tile object: { "P": {source_id, atlas_x, atlas_y, alt?} }.',
          additionalProperties: {
            type: 'object',
            properties: {
              source_id: { type: 'integer' },
              atlas_x: { type: 'integer' },
              atlas_y: { type: 'integer' },
              alt: { type: 'integer' },
            },
            required: ['atlas_x', 'atlas_y'],
          },
        },
      },
      required: ['scene_path', 'layer_name', 'x', 'y', 'pattern', 'palette'],
    },
  },
  {
    name: 'erase_tiles',
    description: 'Remove tiles at specific positions from a TileMapLayer.',
    inputSchema: {
      type: 'object',
      properties: {
        scene_path: { type: 'string', description: 'Path to the .tscn scene file.' },
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
        layer_name: { type: 'string', description: 'Name of the TileMapLayer node. Use path-qualified name (e.g. "Dim_n1/TileMapLayer_Base") to target a specific dimension.' },
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
          case 'analyze_tilemap_patterns': result = await toolAnalyzeTilemapPatterns(args); break;
          case 'set_tiles':        result = await toolSetTiles(args);           break;
          case 'fill_rect':        result = await toolFillRect(args);           break;
          case 'paint_path':       result = await toolPaintPath(args);          break;
          case 'stamp_pattern':    result = await toolStampPattern(args);       break;
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
