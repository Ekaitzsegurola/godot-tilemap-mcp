/**
 * tileData.js – Encode / decode Godot 4 TileMapLayer PackedByteArray tile data.
 *
 * The PackedByteArray starts with a 2-byte format version header, then
 * 12 bytes per cell (all little-endian):
 *
 *   Header (2 bytes):
 *     bytes 0-1  uint16  format version (currently 0 or 1)
 *
 *   Per cell (12 bytes):
 *     bytes  0-1  int16   cell X
 *     bytes  2-3  int16   cell Y
 *     bytes  4-5  uint16  source_id
 *     bytes  6-7  uint16  atlas_coords.x
 *     bytes  8-9  uint16  atlas_coords.y
 *     bytes 10-11 uint16  alternative_tile
 *
 * Reference: godotengine/godot scene/2d/tile_map_layer.cpp
 *   get_tile_map_data_as_array / set_tile_map_data_from_array
 */

const HEADER_SIZE = 2;  // uint16 format version
const CELL_SIZE   = 12; // bytes per cell

/**
 * Decode a base64 string into an array of tile cell objects.
 * @param {string} base64 – raw base64 (no wrapping, no whitespace)
 * @returns {{x:number, y:number, source_id:number, atlas_x:number, atlas_y:number, alt:number}[]}
 */
export function decodeTileData(base64) {
  if (!base64 || base64.length === 0) return [];

  const buf = Buffer.from(base64, 'base64');
  if (buf.length < HEADER_SIZE) return [];

  // Skip the 2-byte format version header
  const dataStart = HEADER_SIZE;
  const dataLen = buf.length - dataStart;
  const cellCount = Math.floor(dataLen / CELL_SIZE);
  const cells = [];

  for (let i = 0; i < cellCount; i++) {
    const off = dataStart + i * CELL_SIZE;
    cells.push({
      x:         buf.readInt16LE(off),
      y:         buf.readInt16LE(off + 2),
      source_id: buf.readUInt16LE(off + 4),
      atlas_x:   buf.readUInt16LE(off + 6),
      atlas_y:   buf.readUInt16LE(off + 8),
      alt:       buf.readUInt16LE(off + 10),
    });
  }

  return cells;
}

/**
 * Encode an array of tile cell objects into a base64 string.
 * Prepends the 2-byte format version header (version 0).
 * @param {{x:number, y:number, source_id:number, atlas_x:number, atlas_y:number, alt?:number}[]} cells
 * @returns {string} base64-encoded PackedByteArray content
 */
export function encodeTileData(cells) {
  if (!cells || cells.length === 0) return '';

  const buf = Buffer.alloc(HEADER_SIZE + cells.length * CELL_SIZE);

  // Write format version header (version 0)
  buf.writeUInt16LE(0, 0);

  for (let i = 0; i < cells.length; i++) {
    const c = cells[i];
    const off = HEADER_SIZE + i * CELL_SIZE;
    buf.writeInt16LE(c.x,              off);
    buf.writeInt16LE(c.y,              off + 2);
    buf.writeUInt16LE(c.source_id,     off + 4);
    buf.writeUInt16LE(c.atlas_x,       off + 6);
    buf.writeUInt16LE(c.atlas_y,       off + 8);
    buf.writeUInt16LE(c.alt ?? 0,      off + 10);
  }

  return buf.toString('base64');
}
