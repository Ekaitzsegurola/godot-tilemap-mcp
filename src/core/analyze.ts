import type { LayerSnapshot } from "./project.js";
import type { ProjectProfile } from "./profile.js";
import type {
  AnalysisReport,
  AnalysisWarning,
  CatalogTile,
  Point,
  Region,
  TileCell,
  TileRef,
  TileSetCatalog,
} from "./types.js";
import { calculateBounds, cellKey, tileKey } from "./types.js";

export interface TileSearchQuery {
  text?: string;
  sourceId?: number;
  terrainSet?: number;
  terrain?: number;
  customData?: Record<string, unknown>;
  hasPhysics?: boolean;
  hasNavigation?: boolean;
  limit?: number;
}

export interface ExtractedPattern {
  width: number;
  height: number;
  pattern: string[];
  palette: Record<string, TileRef>;
  legend: Record<string, string>;
  emptySymbol: ".";
}

function inRegion(cell: Point, region?: Region): boolean {
  return !region
    || (cell.x >= region.x && cell.x < region.x + region.width
      && cell.y >= region.y && cell.y < region.y + region.height);
}

function repeatedAxisRatio(cells: TileCell[], axis: "row" | "column"): number {
  const bounds = calculateBounds(cells);
  if (!bounds) return 0;
  const groups = new Map<number, TileCell[]>();
  for (const cell of cells) {
    const coordinate = axis === "row" ? cell.y : cell.x;
    const values = groups.get(coordinate) ?? [];
    values.push(cell);
    groups.set(coordinate, values);
  }
  const signatures = new Map<string, number>();
  for (let coordinate = axis === "row" ? bounds.minY : bounds.minX;
    coordinate <= (axis === "row" ? bounds.maxY : bounds.maxX);
    coordinate++) {
    const signature = (groups.get(coordinate) ?? [])
      .sort((left, right) => axis === "row" ? left.x - right.x : left.y - right.y)
      .map((cell) => `${axis === "row" ? cell.x : cell.y}:${tileKey(cell)}`)
      .join("|");
    signatures.set(signature, (signatures.get(signature) ?? 0) + 1);
  }
  const total = axis === "row" ? bounds.height : bounds.width;
  const repeated = [...signatures.values()].reduce((sum, count) => sum + (count > 1 ? count : 0), 0);
  return total === 0 ? 0 : repeated / total;
}

function countComponents(cells: TileCell[]): { count: number; isolated: Point[] } {
  const occupied = new Map(cells.map((cell) => [cellKey(cell.x, cell.y), cell]));
  const visited = new Set<string>();
  const isolated: Point[] = [];
  let count = 0;
  for (const cell of cells) {
    const start = cellKey(cell.x, cell.y);
    if (visited.has(start)) continue;
    count++;
    const queue = [cell];
    let componentSize = 0;
    while (queue.length > 0) {
      const current = queue.shift()!;
      const key = cellKey(current.x, current.y);
      if (visited.has(key)) continue;
      visited.add(key);
      componentSize++;
      for (const neighbor of [
        { x: current.x + 1, y: current.y },
        { x: current.x - 1, y: current.y },
        { x: current.x, y: current.y + 1 },
        { x: current.x, y: current.y - 1 },
      ]) {
        const next = occupied.get(cellKey(neighbor.x, neighbor.y));
        if (next && !visited.has(cellKey(next.x, next.y))) queue.push(next);
      }
    }
    if (componentSize === 1) isolated.push({ x: cell.x, y: cell.y });
  }
  return { count, isolated };
}

function longestRuns(cells: TileCell[]): AnalysisReport["longestRuns"] {
  const runs: AnalysisReport["longestRuns"] = [];
  for (const axis of ["horizontal", "vertical"] as const) {
    const sorted = [...cells].sort((left, right) => {
      if (axis === "horizontal") return left.y - right.y || left.x - right.x;
      return left.x - right.x || left.y - right.y;
    });
    let start: TileCell | null = null;
    let previous: TileCell | null = null;
    let length = 0;
    const finish = (): void => {
      if (start && length >= 3) runs.push({ axis, tile: { ...start }, start: { x: start.x, y: start.y }, length });
    };
    for (const cell of sorted) {
      const contiguous = previous !== null
        && tileKey(previous) === tileKey(cell)
        && (axis === "horizontal"
          ? previous.y === cell.y && previous.x + 1 === cell.x
          : previous.x === cell.x && previous.y + 1 === cell.y);
      if (!contiguous) {
        finish();
        start = cell;
        length = 1;
      } else {
        length++;
      }
      previous = cell;
    }
    finish();
  }
  return runs.sort((left, right) => right.length - left.length).slice(0, 24);
}

export function analyzeCells(input: TileCell[], region?: Region): AnalysisReport {
  const cells = input.filter((cell) => inRegion(cell, region));
  const distributionMap = new Map<string, { tile: TileRef; count: number }>();
  for (const cell of cells) {
    const key = tileKey(cell);
    const entry = distributionMap.get(key) ?? { tile: { ...cell }, count: 0 };
    entry.count++;
    distributionMap.set(key, entry);
  }
  const distribution = [...distributionMap.values()]
    .map((entry) => ({ ...entry, ratio: cells.length === 0 ? 0 : entry.count / cells.length }))
    .sort((left, right) => right.count - left.count);
  const entropy = distribution.reduce(
    (sum, entry) => sum - (entry.ratio === 0 ? 0 : entry.ratio * Math.log2(entry.ratio)),
    0,
  );
  const components = countComponents(cells);
  const repeatedRowsRatio = repeatedAxisRatio(cells, "row");
  const repeatedColumnsRatio = repeatedAxisRatio(cells, "column");
  const warnings: AnalysisWarning[] = [];
  if (cells.length === 0) {
    warnings.push({ code: "empty-region", severity: "info", message: "The selected layer or region has no tiles." });
  }
  if ((distribution[0]?.ratio ?? 0) >= 0.8 && cells.length >= 16) {
    warnings.push({ code: "low-variety", severity: "warning", message: `${Math.round(distribution[0]!.ratio * 100)}% of cells use the same tile.` });
  }
  if (repeatedRowsRatio >= 0.6 && cells.length >= 16) {
    warnings.push({ code: "repeated-rows", severity: "warning", message: `${Math.round(repeatedRowsRatio * 100)}% of rows repeat an identical tile signature.` });
  }
  if (repeatedColumnsRatio >= 0.6 && cells.length >= 16) {
    warnings.push({ code: "repeated-columns", severity: "warning", message: `${Math.round(repeatedColumnsRatio * 100)}% of columns repeat an identical tile signature.` });
  }
  if (components.isolated.length > 0) {
    warnings.push({
      code: "isolated-cells",
      severity: components.isolated.length > 8 ? "warning" : "info",
      message: `${components.isolated.length} isolated tile cell(s) found.`,
      positions: components.isolated.slice(0, 128),
    });
  }
  return {
    tileCount: cells.length,
    bounds: calculateBounds(cells),
    distribution,
    entropy,
    repeatedRowsRatio,
    repeatedColumnsRatio,
    connectedComponents: components.count,
    isolatedCells: components.isolated,
    longestRuns: longestRuns(cells),
    warnings,
  };
}

export function analyzeLayer(layer: LayerSnapshot, profile: ProjectProfile | null, region?: Region): AnalysisReport {
  const report = analyzeCells(layer.cells, region);
  if (layer.tileSet) {
    const known = new Set(layer.tileSet.tiles.map(tileKey));
    const unknown = layer.cells.filter((cell) => !known.has(tileKey({ ...cell, alternativeId: cell.alternativeId & 0x0fff })));
    if (unknown.length > 0) {
      report.warnings.push({
        code: "unknown-tile-reference",
        severity: "error",
        message: `${unknown.length} cell(s) reference tiles absent from the statically inspected TileSet.`,
        positions: unknown.slice(0, 128).map(({ x, y }) => ({ x, y })),
      });
    }
    const configuredKeys = [
      profile?.raw.analysis.walk_mask_custom_data,
      profile?.raw.analysis.force_block_custom_data,
    ].filter((key): key is string => Boolean(key));
    for (const key of configuredKeys) {
      if (!layer.tileSet.customDataLayers.some((customLayer) => customLayer.name === key)) {
        report.warnings.push({ code: "missing-custom-data", severity: "warning", message: `Configured custom data layer "${key}" is absent from this TileSet.` });
      }
    }
  }
  return report;
}

function matchesCustomData(tile: CatalogTile, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([key, value]) => Object.is(tile.customData[key], value));
}

export function findCatalogTiles(catalog: TileSetCatalog, query: TileSearchQuery = {}): CatalogTile[] {
  const text = query.text?.trim().toLowerCase();
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 2_000);
  return catalog.tiles.filter((tile) => {
    if (query.sourceId !== undefined && tile.sourceId !== query.sourceId) return false;
    if (query.terrainSet !== undefined && tile.terrainSet !== query.terrainSet) return false;
    if (query.terrain !== undefined && tile.terrain !== query.terrain) return false;
    if (query.hasPhysics !== undefined && tile.hasPhysics !== query.hasPhysics) return false;
    if (query.hasNavigation !== undefined && tile.hasNavigation !== query.hasNavigation) return false;
    if (query.customData && !matchesCustomData(tile, query.customData)) return false;
    if (text) {
      const searchable = `${tile.alias} ${tile.sourceName ?? ""} ${tile.texturePath ?? ""} ${JSON.stringify(tile.customData)}`.toLowerCase();
      if (!searchable.includes(text)) return false;
    }
    return true;
  }).slice(0, limit);
}

const SYMBOLS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@$%&*+=?";

export function extractPattern(cells: TileCell[], region: Region, catalog?: TileSetCatalog | null): ExtractedPattern {
  if (region.width <= 0 || region.height <= 0) throw new Error("Pattern region width and height must be positive");
  const lookup = new Map(cells.filter((cell) => inRegion(cell, region)).map((cell) => [cellKey(cell.x, cell.y), cell]));
  const symbolByTile = new Map<string, string>();
  const palette: Record<string, TileRef> = {};
  const legend: Record<string, string> = {};
  const pattern: string[] = [];
  for (let y = region.y; y < region.y + region.height; y++) {
    let row = "";
    for (let x = region.x; x < region.x + region.width; x++) {
      const cell = lookup.get(cellKey(x, y));
      if (!cell) {
        row += ".";
        continue;
      }
      const key = tileKey(cell);
      let symbol = symbolByTile.get(key);
      if (!symbol) {
        symbol = SYMBOLS[symbolByTile.size];
        if (!symbol) throw new Error(`Pattern contains more than ${SYMBOLS.length} distinct tiles`);
        symbolByTile.set(key, symbol);
        palette[symbol] = {
          sourceId: cell.sourceId,
          atlasX: cell.atlasX,
          atlasY: cell.atlasY,
          alternativeId: cell.alternativeId,
        };
        const catalogTile = catalog?.tiles.find((tile) => tileKey(tile) === key);
        legend[symbol] = catalogTile?.alias ?? key;
      }
      row += symbol;
    }
    pattern.push(row);
  }
  return { width: region.width, height: region.height, pattern, palette, legend, emptySymbol: "." };
}
