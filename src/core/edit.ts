import { encodeTileMapData } from "./tileData.js";
import { getSectionForLayer, parseGodotText } from "./godotText.js";
import { isLayerProtected, type ProjectProfile } from "./profile.js";
import { getLayerSnapshot, type LayerSnapshot, type SceneSnapshot } from "./project.js";
import type {
  CellChange,
  EditOperation,
  EditRecipe,
  LayerEditResult,
  Point,
  Region,
  ShapeDefinition,
  TileCell,
  TileRef,
  TileSelector,
  WeightedTile,
} from "./types.js";
import { calculateBounds, cellKey, sameTile } from "./types.js";

export interface TerrainBridge {
  applyTerrain(input: {
    projectPath: string;
    scenePath: string;
    layerPath: string;
    tileMapDataBase64: string;
    operation: Extract<EditOperation, { op: "terrain_connect" | "terrain_path" }>;
  }): Promise<TileCell[]>;
}

export interface PlannedEdit {
  layers: LayerEditResult[];
  warnings: string[];
}

function seededRandom(seedText: string): () => number {
  let seed = 2166136261;
  for (let index = 0; index < seedText.length; index++) {
    seed ^= seedText.charCodeAt(index);
    seed = Math.imul(seed, 16777619);
  }
  return () => {
    seed += 0x6d2b79f5;
    let value = seed;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

function cloneCell(cell: TileCell): TileCell {
  return { ...cell };
}

function tileAt(tile: TileRef, point: Point): TileCell {
  return { x: point.x, y: point.y, ...tile };
}

function assertPoint(point: Point, label: string): void {
  if (!Number.isInteger(point.x) || !Number.isInteger(point.y)) {
    throw new Error(`${label} must use integer tile coordinates`);
  }
  if (point.x < -32768 || point.x > 32767 || point.y < -32768 || point.y > 32767) {
    throw new Error(`${label} is outside Godot's signed 16-bit TileMapLayer coordinate range`);
  }
}

function pointInPolygon(point: Point, vertices: Point[]): boolean {
  let inside = false;
  for (let left = 0, right = vertices.length - 1; left < vertices.length; right = left++) {
    const a = vertices[left]!;
    const b = vertices[right]!;
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y || Number.EPSILON) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}

function cellsForShape(shape: ShapeDefinition): Point[] {
  if (shape.kind === "cells") {
    shape.cells.forEach((point, index) => assertPoint(point, `shape.cells[${index}]`));
    return shape.cells.map((point) => ({ ...point }));
  }
  if (shape.kind === "polygon") {
    if (shape.points.length < 3) throw new Error("Polygon shapes require at least three points");
    shape.points.forEach((point, index) => assertPoint(point, `shape.points[${index}]`));
    const minX = Math.floor(Math.min(...shape.points.map((point) => point.x)));
    const maxX = Math.ceil(Math.max(...shape.points.map((point) => point.x)));
    const minY = Math.floor(Math.min(...shape.points.map((point) => point.y)));
    const maxY = Math.ceil(Math.max(...shape.points.map((point) => point.y)));
    const result: Point[] = [];
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (pointInPolygon({ x: x + 0.5, y: y + 0.5 }, shape.points)) result.push({ x, y });
      }
    }
    return result;
  }

  if (shape.width <= 0 || shape.height <= 0) throw new Error(`${shape.kind} shape width and height must be positive`);
  assertPoint(shape, `${shape.kind} origin`);
  const result: Point[] = [];
  const centerX = shape.x + shape.width / 2;
  const centerY = shape.y + shape.height / 2;
  const radiusX = shape.width / 2;
  const radiusY = shape.height / 2;
  for (let y = shape.y; y < shape.y + shape.height; y++) {
    for (let x = shape.x; x < shape.x + shape.width; x++) {
      if (shape.kind === "rect") result.push({ x, y });
      else {
        const normalizedX = (x + 0.5 - centerX) / radiusX;
        const normalizedY = (y + 0.5 - centerY) / radiusY;
        if (normalizedX * normalizedX + normalizedY * normalizedY <= 1) result.push({ x, y });
      }
    }
  }
  return result;
}

function linePoints(start: Point, end: Point): Point[] {
  assertPoint(start, "path point");
  assertPoint(end, "path point");
  const result: Point[] = [];
  let x = start.x;
  let y = start.y;
  const dx = Math.abs(end.x - start.x);
  const dy = -Math.abs(end.y - start.y);
  const sx = start.x < end.x ? 1 : -1;
  const sy = start.y < end.y ? 1 : -1;
  let error = dx + dy;
  while (true) {
    result.push({ x, y });
    if (x === end.x && y === end.y) break;
    const twice = 2 * error;
    if (twice >= dy) {
      error += dy;
      x += sx;
    }
    if (twice <= dx) {
      error += dx;
      y += sy;
    }
  }
  return result;
}

function isRawTile(selector: TileSelector): selector is TileRef {
  return "sourceId" in selector;
}

function resolveAlias(selector: TileSelector, layer: LayerSnapshot, profile: ProjectProfile | null): TileRef | WeightedTile[] {
  if (isRawTile(selector)) return selector;
  if ("alias" in selector) {
    const configured = profile?.aliases.get(selector.alias);
    if (configured) return configured;
    const catalogTile = layer.tileSet?.tiles.find((tile) => tile.alias === selector.alias);
    if (catalogTile) return catalogTile;
    throw new Error(`Unknown tile alias "${selector.alias}" for layer ${layer.descriptor.fullPath}`);
  }
  const brush = profile?.brushes.get(selector.brush);
  if (!brush) throw new Error(`Unknown brush "${selector.brush}"`);
  return brush.tiles;
}

function chooseTile(
  selector: TileSelector,
  layer: LayerSnapshot,
  profile: ProjectProfile | null,
  random: () => number,
  depth = 0,
): TileRef {
  if (depth > 8) throw new Error("Brush/alias resolution exceeded its recursion limit");
  const resolved = resolveAlias(selector, layer, profile);
  if (!Array.isArray(resolved)) {
    return {
      sourceId: resolved.sourceId,
      atlasX: resolved.atlasX,
      atlasY: resolved.atlasY,
      alternativeId: resolved.alternativeId,
    };
  }
  const total = resolved.reduce((sum, entry) => sum + (entry.weight ?? 1), 0);
  let roll = random() * total;
  for (const entry of resolved) {
    roll -= entry.weight ?? 1;
    if (roll <= 0) return chooseTile(entry.tile, layer, profile, random, depth + 1);
  }
  return chooseTile(resolved[resolved.length - 1]!.tile, layer, profile, random, depth + 1);
}

function validateTile(tile: TileRef, layer: LayerSnapshot): void {
  for (const [name, value] of [
    ["sourceId", tile.sourceId],
    ["atlasX", tile.atlasX],
    ["atlasY", tile.atlasY],
    ["alternativeId", tile.alternativeId],
  ] as const) {
    if (!Number.isInteger(value) || value < 0 || value > 65535) throw new Error(`${name} must be a uint16, received ${value}`);
  }
  if (!layer.tileSet) return;
  const baseAlternative = tile.alternativeId & 0x0fff;
  const exists = layer.tileSet.tiles.some((candidate) => candidate.sourceId === tile.sourceId
    && candidate.atlasX === tile.atlasX
    && candidate.atlasY === tile.atlasY
    && candidate.alternativeId === baseAlternative);
  const sceneExists = layer.tileSet.sources.some((source) => source.kind === "scenes"
    && source.sourceId === tile.sourceId
    && source.scenes.some((scene) => scene.id === tile.atlasX));
  if (!exists && !sceneExists) {
    throw new Error(
      `Tile ${tile.sourceId}:${tile.atlasX}:${tile.atlasY}:${tile.alternativeId} does not exist in ${layer.tileSet.resourceKey}`,
    );
  }
}

function setCell(map: Map<string, TileCell>, point: Point, tile: TileRef, layer: LayerSnapshot): void {
  assertPoint(point, "cell");
  const reference: TileRef = {
    sourceId: tile.sourceId,
    atlasX: tile.atlasX,
    atlasY: tile.atlasY,
    alternativeId: tile.alternativeId,
  };
  validateTile(reference, layer);
  map.set(cellKey(point.x, point.y), tileAt(reference, point));
}

function inRegion(cell: Point, region: Region | undefined): boolean {
  return !region || (cell.x >= region.x && cell.x < region.x + region.width && cell.y >= region.y && cell.y < region.y + region.height);
}

function applyCopy(map: Map<string, TileCell>, operation: Extract<EditOperation, { op: "copy" }>, layer: LayerSnapshot): void {
  const sourceCells = [...map.values()].filter((cell) => inRegion(cell, operation.source)).map(cloneCell);
  for (const cell of sourceCells) {
    let localX = cell.x - operation.source.x;
    let localY = cell.y - operation.source.y;
    if (operation.flipX) localX = operation.source.width - 1 - localX;
    if (operation.flipY) localY = operation.source.height - 1 - localY;
    const rotation = operation.rotate ?? 0;
    if (rotation === 90) [localX, localY] = [operation.source.height - 1 - localY, localX];
    else if (rotation === 180) [localX, localY] = [operation.source.width - 1 - localX, operation.source.height - 1 - localY];
    else if (rotation === 270) [localX, localY] = [localY, operation.source.width - 1 - localX];
    setCell(map, { x: operation.destination.x + localX, y: operation.destination.y + localY }, cell, layer);
  }
}

async function applyOperation(
  operation: EditOperation,
  map: Map<string, TileCell>,
  layer: LayerSnapshot,
  snapshot: SceneSnapshot,
  profile: ProjectProfile | null,
  random: () => number,
  bridge: TerrainBridge | null,
): Promise<Map<string, TileCell>> {
  if (operation.op === "terrain_connect" || operation.op === "terrain_path") {
    if (!bridge) throw new Error(`${operation.op} requires the Godot headless bridge`);
    const cells = [...map.values()].sort((left, right) => left.y - right.y || left.x - right.x);
    const next = await bridge.applyTerrain({
      projectPath: snapshot.project,
      scenePath: snapshot.scenePath,
      layerPath: layer.descriptor.nodePath,
      tileMapDataBase64: encodeTileMapData(cells, { formatVersion: layer.formatVersion }),
      operation,
    });
    return new Map(next.map((cell) => [cellKey(cell.x, cell.y), cell]));
  }

  switch (operation.op) {
    case "set":
      for (const entry of operation.cells) setCell(map, entry, chooseTile(entry.tile, layer, profile, random), layer);
      break;
    case "erase":
      for (const point of cellsForShape(operation.shape)) map.delete(cellKey(point.x, point.y));
      break;
    case "fill":
      for (const point of cellsForShape(operation.shape)) setCell(map, point, chooseTile(operation.tile, layer, profile, random), layer);
      break;
    case "path": {
      if (operation.points.length < 2) throw new Error("Path operations require at least two points");
      const width = Math.max(1, operation.width ?? 1);
      const minimumOffset = -Math.floor(width / 2);
      const maximumOffset = minimumOffset + width - 1;
      const jitter = Math.max(0, operation.jitter ?? 0);
      const seen = new Set<string>();
      for (let index = 0; index < operation.points.length - 1; index++) {
        for (const point of linePoints(operation.points[index]!, operation.points[index + 1]!)) {
          const center = {
            x: point.x + (jitter > 0 ? Math.round((random() * 2 - 1) * jitter) : 0),
            y: point.y + (jitter > 0 ? Math.round((random() * 2 - 1) * jitter) : 0),
          };
          for (let offsetY = minimumOffset; offsetY <= maximumOffset; offsetY++) {
            for (let offsetX = minimumOffset; offsetX <= maximumOffset; offsetX++) {
              const x = center.x + offsetX;
              const y = center.y + offsetY;
              const key = cellKey(x, y);
              if (seen.has(key)) continue;
              seen.add(key);
              setCell(map, { x, y }, chooseTile(operation.tile, layer, profile, random), layer);
            }
          }
        }
      }
      break;
    }
    case "scatter": {
      if (operation.density < 0 || operation.density > 1) throw new Error("Scatter density must be in [0, 1]");
      const accepted: Point[] = [];
      const minimum = Math.max(0, operation.minDistance ?? 0);
      for (let y = operation.region.y; y < operation.region.y + operation.region.height; y++) {
        for (let x = operation.region.x; x < operation.region.x + operation.region.width; x++) {
          if (random() > operation.density) continue;
          if (minimum > 0 && accepted.some((point) => Math.hypot(point.x - x, point.y - y) < minimum)) continue;
          accepted.push({ x, y });
          setCell(map, { x, y }, chooseTile(operation.tile, layer, profile, random), layer);
        }
      }
      break;
    }
    case "replace": {
      const from = chooseTile(operation.from, layer, profile, random);
      for (const cell of [...map.values()]) {
        if (inRegion(cell, operation.region) && sameTile(cell, from)) {
          setCell(map, cell, chooseTile(operation.to, layer, profile, random), layer);
        }
      }
      break;
    }
    case "stamp":
      for (let row = 0; row < operation.pattern.length; row++) {
        const line = operation.pattern[row]!;
        for (let column = 0; column < line.length; column++) {
          const symbol = line[column]!;
          if (symbol === "." || symbol === " ") continue;
          const selector = operation.palette[symbol];
          if (!selector) throw new Error(`Stamp symbol "${symbol}" has no palette entry`);
          setCell(
            map,
            { x: operation.origin.x + column, y: operation.origin.y + row },
            chooseTile(selector, layer, profile, random),
            layer,
          );
        }
      }
      break;
    case "copy":
      applyCopy(map, operation, layer);
      break;
    case "flood_fill": {
      const startKey = cellKey(operation.start.x, operation.start.y);
      const target = map.get(startKey) ?? null;
      const bounds = layer.bounds;
      if (!target && !bounds) throw new Error("Cannot flood-fill an unbounded empty layer");
      const maxCells = Math.max(1, operation.maxCells ?? 10_000);
      const queue: Point[] = [{ ...operation.start }];
      const visited = new Set<string>();
      while (queue.length > 0) {
        if (visited.size >= maxCells) throw new Error(`Flood fill exceeded its ${maxCells}-cell safety cap`);
        const point = queue.shift()!;
        const key = cellKey(point.x, point.y);
        if (visited.has(key)) continue;
        visited.add(key);
        if (!target && bounds && (point.x < bounds.minX || point.x > bounds.maxX || point.y < bounds.minY || point.y > bounds.maxY)) continue;
        const current = map.get(key) ?? null;
        if (!sameTile(current, target)) continue;
        setCell(map, point, chooseTile(operation.tile, layer, profile, random), layer);
        queue.push({ x: point.x + 1, y: point.y }, { x: point.x - 1, y: point.y }, { x: point.x, y: point.y + 1 }, { x: point.x, y: point.y - 1 });
      }
      break;
    }
  }
  return map;
}

function computeChanges(layerName: string, before: Map<string, TileCell>, after: Map<string, TileCell>): CellChange[] {
  const keys = new Set([...before.keys(), ...after.keys()]);
  const changes: CellChange[] = [];
  for (const key of keys) {
    const previous = before.get(key) ?? null;
    const next = after.get(key) ?? null;
    if (sameTile(previous, next)) continue;
    const [x, y] = key.split(",").map(Number) as [number, number];
    changes.push({
      layer: layerName,
      x,
      y,
      before: previous ? cloneCell(previous) : null,
      after: next ? cloneCell(next) : null,
    });
  }
  return changes.sort((left, right) => left.y - right.y || left.x - right.x);
}

export async function planEdit(
  snapshot: SceneSnapshot,
  recipe: EditRecipe,
  profile: ProjectProfile | null,
  bridge: TerrainBridge | null,
): Promise<PlannedEdit> {
  const random = seededRandom(recipe.seed ?? `${snapshot.revision}:${JSON.stringify(recipe.operations)}`);
  const maxCells = profile?.raw.limits.max_cells_per_edit ?? 50_000;
  const operationsByLayer = new Map<string, EditOperation[]>();
  for (const operation of recipe.operations) {
    const layer = getLayerSnapshot(snapshot, operation.layer);
    if (isLayerProtected(profile, layer.descriptor.fullPath)) {
      throw new Error(`Layer ${layer.descriptor.fullPath} is protected by .godot-tilemap-mcp.json`);
    }
    const operations = operationsByLayer.get(layer.descriptor.fullPath) ?? [];
    operations.push(operation);
    operationsByLayer.set(layer.descriptor.fullPath, operations);
  }

  const results: LayerEditResult[] = [];
  const warnings: string[] = [];
  const sourceDocument = parseGodotText(snapshot.text);
  for (const [layerName, operations] of operationsByLayer) {
    const layer = getLayerSnapshot(snapshot, layerName);
    const original = new Map(layer.cells.map((cell) => [cellKey(cell.x, cell.y), cloneCell(cell)]));
    let current = new Map([...original].map(([key, cell]) => [key, cloneCell(cell)]));
    if (!layer.tileSet) warnings.push(`Layer ${layerName} has no inspectable TileSet; raw references cannot be fully validated.`);
    for (const operation of operations) {
      current = await applyOperation(operation, current, layer, snapshot, profile, random, bridge);
      if (current.size > maxCells) throw new Error(`Edit would grow ${layerName} to ${current.size} cells, above the ${maxCells}-cell limit`);
    }
    const changes = computeChanges(layerName, original, current);
    if (changes.length === 0) continue;
    if (changes.length > maxCells) throw new Error(`Edit changes ${changes.length} cells, above the ${maxCells}-cell limit`);
    const cells = [...current.values()].sort((left, right) => left.y - right.y || left.x - right.x);
    const sourceSection = getSectionForLayer(sourceDocument, layer.descriptor);
    const sourceProperty = sourceSection.properties.find((property) => property.key === "tile_map_data");
    results.push({
      layer: layerName,
      originalBase64: layer.descriptor.tileMapDataBase64,
      originalPropertyLine: sourceProperty
        ? snapshot.text.slice(sourceProperty.lineStart, sourceProperty.contentEnd)
        : null,
      nextBase64: encodeTileMapData(cells, { formatVersion: layer.formatVersion }),
      originalFormatVersion: layer.formatVersion,
      changes,
      bounds: calculateBounds(changes),
    });
  }
  if (results.length === 0) warnings.push("Recipe does not change any tile cells.");
  return { layers: results, warnings };
}
