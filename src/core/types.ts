export interface Point {
  x: number;
  y: number;
}

export interface Region extends Point {
  width: number;
  height: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

export interface TileRef {
  sourceId: number;
  atlasX: number;
  atlasY: number;
  alternativeId: number;
}

export interface TileCell extends TileRef, Point {}

export interface LegacyTileCell {
  x: number;
  y: number;
  source_id: number;
  atlas_x: number;
  atlas_y: number;
  alt: number;
}

export interface LayerDescriptor {
  name: string;
  parent: string;
  fullPath: string;
  nodePath: string;
  tileMapDataBase64: string | null;
  tileSetKind: "external" | "embedded" | null;
  tileSetId: string | null;
  tileSetPath: string | null;
  zIndex: number;
  visible: boolean;
  enabled: boolean;
  position: Point;
}

export interface CustomDataLayer {
  index: number;
  name: string;
  variantType: number | null;
}

export interface TerrainDefinition {
  setId: number;
  terrainId: number;
  name: string;
  color: string | null;
}

export interface CatalogTile extends TileRef {
  sourceName: string | null;
  texturePath: string | null;
  textureRegionSize: Point;
  margins: Point;
  separation: Point;
  sizeInAtlas: Point;
  customData: Record<string, unknown>;
  terrainSet: number | null;
  terrain: number | null;
  terrainPeering: Record<string, number>;
  probability: number;
  animation: Record<string, unknown>;
  hasPhysics: boolean;
  hasNavigation: boolean;
  alias: string;
}

export interface TileSetSourceCatalog {
  sourceId: number;
  kind: "atlas" | "scenes" | "unknown";
  resourceName: string | null;
  texturePath: string | null;
  textureRegionSize: Point;
  margins: Point;
  separation: Point;
  tiles: CatalogTile[];
  scenes: Array<{ id: number; path: string | null }>;
}

export interface TileSetCatalog {
  resourceKey: string;
  filePath: string;
  subresourceId: string | null;
  tileSize: Point;
  tileShape: number;
  tileLayout: number;
  tileOffsetAxis: number;
  customDataLayers: CustomDataLayer[];
  terrains: TerrainDefinition[];
  physicsLayerCount: number;
  navigationLayerCount: number;
  sources: TileSetSourceCatalog[];
  tiles: CatalogTile[];
  warnings: string[];
}

export interface WeightedTile {
  tile: TileSelector;
  weight?: number;
}

export type TileSelector =
  | TileRef
  | { alias: string }
  | { brush: string };

export interface BrushDefinition {
  tiles: WeightedTile[];
}

export type ShapeDefinition =
  | ({ kind: "rect" } & Region)
  | ({ kind: "ellipse" } & Region)
  | { kind: "polygon"; points: Point[] }
  | { kind: "cells"; cells: Point[] };

export type EditOperation =
  | { op: "set"; layer: string; cells: Array<Point & { tile: TileSelector }> }
  | { op: "erase"; layer: string; shape: ShapeDefinition }
  | { op: "fill"; layer: string; shape: ShapeDefinition; tile: TileSelector }
  | { op: "flood_fill"; layer: string; start: Point; tile: TileSelector; maxCells?: number }
  | { op: "path"; layer: string; points: Point[]; tile: TileSelector; width?: number; jitter?: number }
  | { op: "scatter"; layer: string; region: Region; tile: TileSelector; density: number; minDistance?: number }
  | { op: "replace"; layer: string; region?: Region; from: TileSelector; to: TileSelector }
  | { op: "stamp"; layer: string; origin: Point; pattern: string[]; palette: Record<string, TileSelector> }
  | { op: "copy"; layer: string; source: Region; destination: Point; flipX?: boolean; flipY?: boolean; rotate?: 0 | 90 | 180 | 270 }
  | { op: "terrain_connect"; layer: string; cells: Point[]; terrainSet: number; terrain: number; ignoreEmptyTerrains?: boolean }
  | { op: "terrain_path"; layer: string; points: Point[]; terrainSet: number; terrain: number; ignoreEmptyTerrains?: boolean };

export interface EditRecipe {
  scenePath: string;
  projectPath?: string;
  seed?: string;
  operations: EditOperation[];
  expectedRevision?: string;
  includePreview?: boolean;
}

export interface CellChange {
  layer: string;
  x: number;
  y: number;
  before: TileCell | null;
  after: TileCell | null;
}

export interface LayerEditResult {
  layer: string;
  originalBase64: string | null;
  originalPropertyLine: string | null;
  nextBase64: string;
  originalFormatVersion: number;
  changes: CellChange[];
  bounds: Bounds | null;
}

export interface EditTransaction {
  id: string;
  projectPath: string;
  scenePath: string;
  baseRevision: string;
  createdAt: string;
  expiresAt: string;
  recipe: EditRecipe;
  layers: LayerEditResult[];
  warnings: string[];
  preview?: {
    beforePng: string;
    afterPng: string;
    diffPng: string;
    reportHtml: string;
  };
  appliedRevision?: string;
  appliedAt?: string;
  undoneRevision?: string;
  undoneAt?: string;
}

export interface AnalysisWarning {
  code: string;
  severity: "info" | "warning" | "error";
  message: string;
  positions?: Point[];
}

export interface AnalysisReport {
  tileCount: number;
  bounds: Bounds | null;
  distribution: Array<{ tile: TileRef; count: number; ratio: number }>;
  entropy: number;
  repeatedRowsRatio: number;
  repeatedColumnsRatio: number;
  connectedComponents: number;
  isolatedCells: Point[];
  longestRuns: Array<{ axis: "horizontal" | "vertical"; tile: TileRef; start: Point; length: number }>;
  warnings: AnalysisWarning[];
}

export function tileKey(tile: TileRef): string {
  return `${tile.sourceId}:${tile.atlasX}:${tile.atlasY}:${tile.alternativeId}`;
}

export function cellKey(x: number, y: number): string {
  return `${x},${y}`;
}

export function calculateBounds(cells: Point[]): Bounds | null {
  if (cells.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const cell of cells) {
    minX = Math.min(minX, cell.x);
    maxX = Math.max(maxX, cell.x);
    minY = Math.min(minY, cell.y);
    maxY = Math.max(maxY, cell.y);
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

export function sameTile(a: TileRef | null, b: TileRef | null): boolean {
  if (a === null || b === null) return a === b;
  return a.sourceId === b.sourceId
    && a.atlasX === b.atlasX
    && a.atlasY === b.atlasY
    && a.alternativeId === b.alternativeId;
}
