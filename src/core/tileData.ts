import type { LegacyTileCell, TileCell } from "./types.js";

const HEADER_SIZE = 2;
const CELL_SIZE = 12;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export interface DecodedTileMapData {
  formatVersion: number;
  cells: TileCell[];
  byteLength: number;
  hadHeader: boolean;
}

export class TileDataFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TileDataFormatError";
  }
}

function assertIntegerInRange(name: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new TileDataFormatError(`${name} must be an integer in [${min}, ${max}], received ${value}`);
  }
}

export function decodeTileMapData(base64: string | null | undefined): DecodedTileMapData {
  if (!base64) {
    return { formatVersion: 0, cells: [], byteLength: 0, hadHeader: false };
  }

  const normalized = base64.replace(/\s+/g, "");
  if (!BASE64_PATTERN.test(normalized)) {
    throw new TileDataFormatError("tile_map_data is not valid base64");
  }

  const buffer = Buffer.from(normalized, "base64");
  if (buffer.length < HEADER_SIZE) {
    throw new TileDataFormatError(`tile_map_data has ${buffer.length} byte(s); expected an empty value or at least a 2-byte header`);
  }

  const payloadLength = buffer.length - HEADER_SIZE;
  if (payloadLength % CELL_SIZE !== 0) {
    throw new TileDataFormatError(
      `tile_map_data payload is ${payloadLength} bytes; expected a multiple of ${CELL_SIZE}`,
    );
  }

  const cells: TileCell[] = [];
  for (let offset = HEADER_SIZE; offset < buffer.length; offset += CELL_SIZE) {
    cells.push({
      x: buffer.readInt16LE(offset),
      y: buffer.readInt16LE(offset + 2),
      sourceId: buffer.readUInt16LE(offset + 4),
      atlasX: buffer.readUInt16LE(offset + 6),
      atlasY: buffer.readUInt16LE(offset + 8),
      alternativeId: buffer.readUInt16LE(offset + 10),
    });
  }

  return {
    formatVersion: buffer.readUInt16LE(0),
    cells,
    byteLength: buffer.length,
    hadHeader: true,
  };
}

export function encodeTileMapData(
  cells: TileCell[],
  options: { formatVersion?: number; emptyWithoutHeader?: boolean } = {},
): string {
  const formatVersion = options.formatVersion ?? 0;
  assertIntegerInRange("formatVersion", formatVersion, 0, 0xffff);
  if (cells.length === 0 && (options.emptyWithoutHeader ?? false)) return "";

  const buffer = Buffer.alloc(HEADER_SIZE + cells.length * CELL_SIZE);
  buffer.writeUInt16LE(formatVersion, 0);
  for (let index = 0; index < cells.length; index++) {
    const cell = cells[index]!;
    assertIntegerInRange(`cells[${index}].x`, cell.x, -0x8000, 0x7fff);
    assertIntegerInRange(`cells[${index}].y`, cell.y, -0x8000, 0x7fff);
    assertIntegerInRange(`cells[${index}].sourceId`, cell.sourceId, 0, 0xffff);
    assertIntegerInRange(`cells[${index}].atlasX`, cell.atlasX, 0, 0xffff);
    assertIntegerInRange(`cells[${index}].atlasY`, cell.atlasY, 0, 0xffff);
    assertIntegerInRange(`cells[${index}].alternativeId`, cell.alternativeId, 0, 0xffff);
    const offset = HEADER_SIZE + index * CELL_SIZE;
    buffer.writeInt16LE(cell.x, offset);
    buffer.writeInt16LE(cell.y, offset + 2);
    buffer.writeUInt16LE(cell.sourceId, offset + 4);
    buffer.writeUInt16LE(cell.atlasX, offset + 6);
    buffer.writeUInt16LE(cell.atlasY, offset + 8);
    buffer.writeUInt16LE(cell.alternativeId, offset + 10);
  }
  return buffer.toString("base64");
}

export function decodeTileData(base64: string): LegacyTileCell[] {
  return decodeTileMapData(base64).cells.map((cell) => ({
    x: cell.x,
    y: cell.y,
    source_id: cell.sourceId,
    atlas_x: cell.atlasX,
    atlas_y: cell.atlasY,
    alt: cell.alternativeId,
  }));
}

export function encodeTileData(cells: LegacyTileCell[]): string {
  return encodeTileMapData(cells.map((cell) => ({
    x: cell.x,
    y: cell.y,
    sourceId: cell.source_id,
    atlasX: cell.atlas_x,
    atlasY: cell.atlas_y,
    alternativeId: cell.alt ?? 0,
  })));
}
