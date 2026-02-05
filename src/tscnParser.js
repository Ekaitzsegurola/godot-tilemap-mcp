/**
 * tscnParser.js – Parse and surgically edit Godot 4 .tscn (text scene) files.
 *
 * Section-based format:
 *   [gd_scene load_steps=N format=F uid="..."]
 *   [ext_resource type="T" uid="..." path="..." id="ID"]
 *   [sub_resource type="T" id="ID"]
 *   [node name="N" type="T" parent="P"]
 *   key = value
 */

import { readFile, writeFile } from 'node:fs/promises';

// ---------------------------------------------------------------------------
// Low-level section parser
// ---------------------------------------------------------------------------

/**
 * Parse a .tscn file into an ordered array of sections.
 * Each section: { header, headerLine, type, attrs, properties: [{key, value, line}], startLine, endLine }
 * @param {string} filePath
 */
export async function parseTscn(filePath) {
  const text = await readFile(filePath, 'utf-8');
  return parseTscnText(text);
}

/**
 * Parse .tscn text content (without reading a file).
 */
export function parseTscnText(text) {
  const lines = text.split('\n');
  const sections = [];
  let current = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const headerMatch = line.match(/^\[(\w+)(\s+.*?)?\]\s*$/);

    if (headerMatch) {
      if (current) {
        current.endLine = i - 1;
        sections.push(current);
      }
      const type = headerMatch[1]; // gd_scene, ext_resource, sub_resource, node, connection
      const attrStr = (headerMatch[2] || '').trim();
      current = {
        header: line,
        headerLine: i,
        type,
        attrs: parseHeaderAttrs(attrStr),
        properties: [],
        startLine: i,
        endLine: -1,
      };
    } else if (current && line.trim().length > 0) {
      const propMatch = line.match(/^(\S+)\s*=\s*(.*)/);
      if (propMatch) {
        current.properties.push({
          key: propMatch[1],
          value: propMatch[2],
          line: i,
        });
      }
    }
  }

  if (current) {
    current.endLine = lines.length - 1;
    sections.push(current);
  }

  return { sections, lines };
}

/**
 * Parse key=value pairs from a section header string.
 * E.g. 'type="TileSet" uid="uid://x" path="res://foo" id="4"'
 */
function parseHeaderAttrs(str) {
  const attrs = {};
  const re = /(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    let val = m[2];
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1);
    }
    attrs[m[1]] = val;
  }
  return attrs;
}

// ---------------------------------------------------------------------------
// Higher-level helpers
// ---------------------------------------------------------------------------

/**
 * Build a lookup of ext_resource id -> { type, path, uid }
 */
export function buildExtResourceMap(parsed) {
  const map = {};
  for (const s of parsed.sections) {
    if (s.type === 'ext_resource') {
      map[s.attrs.id] = {
        type: s.attrs.type,
        path: s.attrs.path,
        uid: s.attrs.uid,
      };
    }
  }
  return map;
}

/**
 * Find all [node] sections whose type is "TileMapLayer".
 * Returns enriched objects with decoded properties.
 */
export function findTileMapLayers(parsed) {
  const extRes = buildExtResourceMap(parsed);
  const layers = [];

  for (const s of parsed.sections) {
    if (s.type !== 'node') continue;
    if (s.attrs.type !== 'TileMapLayer') continue;

    const name = s.attrs.name;
    const parent = s.attrs.parent || '';

    // Extract key properties
    let tileMapDataB64 = null;
    let tileSetRef = null;
    let tileSetExtId = null;
    let zIndex = 0;
    let visible = true;
    let position = { x: 0, y: 0 };

    for (const p of s.properties) {
      if (p.key === 'tile_map_data') {
        // PackedByteArray("base64...")
        const b64Match = p.value.match(/PackedByteArray\("([A-Za-z0-9+/=]*)"\)/);
        if (b64Match) {
          tileMapDataB64 = b64Match[1];
        }
      } else if (p.key === 'tile_set') {
        const extMatch = p.value.match(/ExtResource\("([^"]+)"\)/);
        if (extMatch) {
          tileSetExtId = extMatch[1];
          const ext = extRes[extMatch[1]];
          if (ext) tileSetRef = ext.path;
        }
      } else if (p.key === 'z_index') {
        zIndex = parseInt(p.value, 10) || 0;
      } else if (p.key === 'visible') {
        visible = p.value.trim() !== 'false';
      } else if (p.key === 'position') {
        const posMatch = p.value.match(/Vector2\(\s*([\d.-]+)\s*,\s*([\d.-]+)\s*\)/);
        if (posMatch) {
          position = { x: parseFloat(posMatch[1]), y: parseFloat(posMatch[2]) };
        }
      }
    }

    layers.push({
      name,
      parent,
      tileMapDataB64,
      tileSetRef,
      tileSetExtId,
      zIndex,
      visible,
      position,
      section: s,
    });
  }

  return layers;
}

/**
 * Surgically replace tile_map_data for a named TileMapLayer inside a .tscn file.
 * If the layer has no tile_map_data property yet, one is inserted after tile_set (or the header).
 * @param {string} filePath
 * @param {string} layerName
 * @param {string} newBase64
 */
export async function updateTileMapData(filePath, layerName, newBase64) {
  const text = await readFile(filePath, 'utf-8');
  const parsed = parseTscnText(text);
  const layers = findTileMapLayers(parsed);
  const layer = layers.find(l => l.name === layerName);

  if (!layer) {
    throw new Error(`TileMapLayer "${layerName}" not found in ${filePath}`);
  }

  const lines = parsed.lines;
  const newLine = `tile_map_data = PackedByteArray("${newBase64}")`;

  // Find existing tile_map_data property line
  const existingProp = layer.section.properties.find(p => p.key === 'tile_map_data');

  if (existingProp) {
    // Replace in-place
    lines[existingProp.line] = newLine;
  } else {
    // Insert after tile_set line, or after the header if no tile_set
    const tileSetProp = layer.section.properties.find(p => p.key === 'tile_set');
    const insertAfter = tileSetProp ? tileSetProp.line : layer.section.headerLine;
    lines.splice(insertAfter + 1, 0, newLine);
  }

  await writeFile(filePath, lines.join('\n'), 'utf-8');
}
