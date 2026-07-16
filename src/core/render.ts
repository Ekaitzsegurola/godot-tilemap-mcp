import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp, { type OverlayOptions } from "sharp";
import type { LayerEditResult, Point, Region, TileCell, TileRef, TileSetCatalog } from "./types.js";
import { calculateBounds, cellKey, tileKey } from "./types.js";
import type { LayerSnapshot, SceneSnapshot } from "./project.js";
import { decodeTileMapData } from "./tileData.js";

export interface RenderOptions {
  layers?: string[];
  region?: Region;
  scale?: number;
  background?: "transparent" | "checker" | string;
  grid?: boolean;
  maxPixels?: number;
  cellsOverride?: Map<string, TileCell[]>;
  highlights?: Array<{ x: number; y: number; color: string }>;
}

export interface RenderedImage {
  png: Buffer;
  bounds: Region;
  pixelWidth: number;
  pixelHeight: number;
  tileSize: Point;
  warnings: string[];
}

export interface PreviewArtifacts {
  beforePng: string;
  afterPng: string;
  diffPng: string;
  reportHtml: string;
}

function xmlEscape(input: string): string {
  return input.replace(/[<>&"']/g, (character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
    "\"": "&quot;",
    "'": "&apos;",
  })[character]!);
}

function parseColor(input: RenderOptions["background"]): { r: number; g: number; b: number; alpha: number } {
  if (!input || input === "transparent" || input === "checker") return { r: 20, g: 24, b: 32, alpha: input === "transparent" ? 0 : 1 };
  const match = input.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
  if (!match) throw new Error(`Invalid render background "${input}"; use transparent, checker or #RRGGBB[AA]`);
  return {
    r: Number.parseInt(match[1]!.slice(0, 2), 16),
    g: Number.parseInt(match[1]!.slice(2, 4), 16),
    b: Number.parseInt(match[1]!.slice(4, 6), 16),
    alpha: match[2] ? Number.parseInt(match[2], 16) / 255 : 1,
  };
}

function colorForTile(tile: TileRef): string {
  let hash = 2166136261;
  for (const character of tileKey(tile)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue} 55% 48%)`;
}

function resourceFile(project: string, resourcePath: string): string {
  if (resourcePath.startsWith("res://")) return path.join(project, resourcePath.slice(6));
  return path.isAbsolute(resourcePath) ? resourcePath : path.join(project, resourcePath);
}

async function atlasTileBuffer(
  project: string,
  tile: TileCell,
  catalog: TileSetCatalog,
  outputSize: Point,
): Promise<Buffer | null> {
  const baseAlternative = tile.alternativeId & 0x0fff;
  const definition = catalog.tiles.find((candidate) => candidate.sourceId === tile.sourceId
    && candidate.atlasX === tile.atlasX
    && candidate.atlasY === tile.atlasY
    && candidate.alternativeId === baseAlternative)
    ?? catalog.tiles.find((candidate) => candidate.sourceId === tile.sourceId
      && candidate.atlasX === tile.atlasX
      && candidate.atlasY === tile.atlasY
      && candidate.alternativeId === 0);
  if (!definition?.texturePath) return null;
  const width = Math.max(1, definition.textureRegionSize.x * definition.sizeInAtlas.x);
  const height = Math.max(1, definition.textureRegionSize.y * definition.sizeInAtlas.y);
  const left = definition.margins.x + definition.atlasX * (definition.textureRegionSize.x + definition.separation.x);
  const top = definition.margins.y + definition.atlasY * (definition.textureRegionSize.y + definition.separation.y);
  try {
    let pipeline = sharp(resourceFile(project, definition.texturePath), { failOn: "none" })
      .extract({ left, top, width, height });
    if ((tile.alternativeId & 0x1000) !== 0) pipeline = pipeline.flop();
    if ((tile.alternativeId & 0x2000) !== 0) pipeline = pipeline.flip();
    if ((tile.alternativeId & 0x4000) !== 0) pipeline = pipeline.rotate(90);
    return await pipeline
      .resize(outputSize.x, outputSize.y, { fit: "fill", kernel: "nearest" })
      .png()
      .toBuffer();
  } catch {
    return null;
  }
}

function placeholderTile(tile: TileRef, size: Point): Buffer {
  const label = `${tile.sourceId}:${tile.atlasX},${tile.atlasY}`;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size.x}" height="${size.y}">
    <rect width="100%" height="100%" fill="${colorForTile(tile)}"/>
    <path d="M0 0L${size.x} ${size.y}M${size.x} 0L0 ${size.y}" stroke="#ffffff55" stroke-width="1"/>
    <text x="${size.x / 2}" y="${size.y / 2}" text-anchor="middle" dominant-baseline="central" fill="white" font-family="monospace" font-size="${Math.max(5, Math.floor(size.y / 5))}">${xmlEscape(label)}</text>
  </svg>`);
}

function checkerSvg(width: number, height: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="c" width="16" height="16" patternUnits="userSpaceOnUse"><rect width="16" height="16" fill="#151922"/><path d="M0 0h8v8H0zM8 8h8v8H8z" fill="#202735"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#c)"/>
  </svg>`);
}

function gridSvg(width: number, height: number, tileWidth: number, tileHeight: number): Buffer {
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><pattern id="g" width="${tileWidth}" height="${tileHeight}" patternUnits="userSpaceOnUse"><path d="M ${tileWidth} 0 L 0 0 0 ${tileHeight}" fill="none" stroke="#ffffff40" stroke-width="1"/></pattern></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`);
}

function highlightSvg(region: Region, tileSize: Point, highlights: NonNullable<RenderOptions["highlights"]>): Buffer {
  const rectangles = highlights.map((entry) => {
    const x = (entry.x - region.x) * tileSize.x;
    const y = (entry.y - region.y) * tileSize.y;
    return `<rect x="${x + 1}" y="${y + 1}" width="${Math.max(1, tileSize.x - 2)}" height="${Math.max(1, tileSize.y - 2)}" fill="none" stroke="${xmlEscape(entry.color)}" stroke-width="${Math.max(2, Math.floor(Math.min(tileSize.x, tileSize.y) / 8))}"/>`;
  }).join("");
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${region.width * tileSize.x}" height="${region.height * tileSize.y}">${rectangles}</svg>`);
}

function selectedLayers(snapshot: SceneSnapshot, options: RenderOptions): LayerSnapshot[] {
  if (!options.layers?.length) return snapshot.layers.filter((layer) => layer.descriptor.visible && layer.descriptor.enabled);
  const requested = new Set(options.layers);
  return snapshot.layers.filter((layer) => requested.has(layer.descriptor.fullPath) || requested.has(layer.descriptor.name));
}

export async function renderSceneImage(snapshot: SceneSnapshot, options: RenderOptions = {}): Promise<RenderedImage> {
  const layers = selectedLayers(snapshot, options).sort((left, right) => left.descriptor.zIndex - right.descriptor.zIndex);
  if (layers.length === 0) throw new Error("No matching visible TileMapLayer was selected for rendering");
  const scale = Math.min(Math.max(options.scale ?? 1, 0.25), 16);
  const baseTileSize = layers.find((layer) => layer.tileSet)?.tileSet?.tileSize ?? { x: 16, y: 16 };
  const tileSize = {
    x: Math.max(1, Math.round(baseTileSize.x * scale)),
    y: Math.max(1, Math.round(baseTileSize.y * scale)),
  };
  const cells = layers.flatMap((layer) => options.cellsOverride?.get(layer.descriptor.fullPath) ?? layer.cells);
  const calculated = calculateBounds(cells);
  const region = options.region ?? (calculated
    ? { x: calculated.minX, y: calculated.minY, width: calculated.width, height: calculated.height }
    : { x: 0, y: 0, width: 1, height: 1 });
  if (region.width <= 0 || region.height <= 0) throw new Error("Render region width and height must be positive");
  const pixelWidth = Math.ceil(region.width * tileSize.x);
  const pixelHeight = Math.ceil(region.height * tileSize.y);
  const maxPixels = options.maxPixels ?? 16_777_216;
  if (pixelWidth * pixelHeight > maxPixels) {
    throw new Error(`Render would create ${pixelWidth}x${pixelHeight} (${pixelWidth * pixelHeight} pixels), above the ${maxPixels}-pixel limit`);
  }
  const background = parseColor(options.background);
  const composites: OverlayOptions[] = [];
  if (options.background === "checker") composites.push({ input: checkerSvg(pixelWidth, pixelHeight), left: 0, top: 0 });
  const tileCache = new Map<string, Promise<Buffer | null>>();
  const warnings = new Set<string>();
  for (const layer of layers) {
    const layerCells = options.cellsOverride?.get(layer.descriptor.fullPath) ?? layer.cells;
    for (const cell of layerCells) {
      if (cell.x < region.x || cell.x >= region.x + region.width || cell.y < region.y || cell.y >= region.y + region.height) continue;
      const cacheKey = `${layer.tileSet?.resourceKey ?? "none"}:${tileKey(cell)}:${tileSize.x}x${tileSize.y}`;
      let promise = tileCache.get(cacheKey);
      if (!promise) {
        promise = layer.tileSet
          ? atlasTileBuffer(snapshot.project, cell, layer.tileSet, tileSize)
          : Promise.resolve(null);
        tileCache.set(cacheKey, promise);
      }
      const rendered = await promise;
      if (!rendered) warnings.add(`Some cells in ${layer.descriptor.fullPath} use a missing or non-atlas texture and were rendered as labeled placeholders.`);
      composites.push({
        input: rendered ?? placeholderTile(cell, tileSize),
        left: Math.round((cell.x - region.x) * tileSize.x),
        top: Math.round((cell.y - region.y) * tileSize.y),
      });
    }
  }
  if (options.grid) composites.push({ input: gridSvg(pixelWidth, pixelHeight, tileSize.x, tileSize.y), left: 0, top: 0 });
  if (options.highlights?.length) composites.push({ input: highlightSvg(region, tileSize, options.highlights), left: 0, top: 0 });
  const canvas = sharp({ create: { width: pixelWidth, height: pixelHeight, channels: 4, background } });
  return {
    png: await (composites.length > 0 ? canvas.composite(composites) : canvas).png().toBuffer(),
    bounds: region,
    pixelWidth,
    pixelHeight,
    tileSize,
    warnings: [...warnings],
  };
}

export async function renderCatalogImage(
  project: string,
  catalog: TileSetCatalog,
  tiles = catalog.tiles,
  options: { columns?: number; tilePixels?: number; maxTiles?: number } = {},
): Promise<Buffer> {
  const selected = tiles.slice(0, Math.min(options.maxTiles ?? 256, 1_024));
  const tilePixels = Math.min(Math.max(options.tilePixels ?? 64, 24), 256);
  const labelHeight = 22;
  const columns = Math.min(Math.max(options.columns ?? Math.ceil(Math.sqrt(Math.max(1, selected.length))), 1), 32);
  const rows = Math.max(1, Math.ceil(selected.length / columns));
  const composites: OverlayOptions[] = [];
  for (let index = 0; index < selected.length; index++) {
    const tile = selected[index]!;
    const cell: TileCell = { x: 0, y: 0, ...tile };
    const image = await atlasTileBuffer(project, cell, catalog, { x: tilePixels, y: tilePixels });
    const left = (index % columns) * tilePixels;
    const top = Math.floor(index / columns) * (tilePixels + labelHeight);
    composites.push({ input: image ?? placeholderTile(tile, { x: tilePixels, y: tilePixels }), left, top });
    composites.push({
      input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${tilePixels}" height="${labelHeight}"><rect width="100%" height="100%" fill="#111827"/><text x="4" y="15" fill="#dbeafe" font-family="monospace" font-size="10">${xmlEscape(tile.alias.slice(0, Math.max(4, Math.floor(tilePixels / 6))))}</text></svg>`),
      left,
      top: top + tilePixels,
    });
  }
  const canvas = sharp({
    create: {
      width: columns * tilePixels,
      height: rows * (tilePixels + labelHeight),
      channels: 4,
      background: { r: 15, g: 23, b: 42, alpha: 1 },
    },
  });
  return (composites.length > 0 ? canvas.composite(composites) : canvas).png().toBuffer();
}

function previewRegion(edits: LayerEditResult[]): Region | undefined {
  const points = edits.flatMap((layer) => layer.changes.map(({ x, y }) => ({ x, y })));
  const bounds = calculateBounds(points);
  if (!bounds) return undefined;
  const padding = 2;
  return {
    x: bounds.minX - padding,
    y: bounds.minY - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

export async function writeEditPreview(snapshot: SceneSnapshot, edits: LayerEditResult[], outputDirectory: string, maxPixels?: number): Promise<PreviewArtifacts> {
  await mkdir(outputDirectory, { recursive: true });
  const layers = edits.map((edit) => edit.layer);
  const region = previewRegion(edits);
  const override = new Map<string, TileCell[]>();
  for (const edit of edits) override.set(edit.layer, decodeTileMapData(edit.nextBase64).cells);
  const highlights = edits.flatMap((edit) => edit.changes.map((change) => ({
    x: change.x,
    y: change.y,
    color: change.before === null ? "#22c55e" : change.after === null ? "#ef4444" : "#f59e0b",
  })));
  const common: RenderOptions = {
    layers,
    ...(region ? { region } : {}),
    background: "checker",
    grid: true,
    ...(maxPixels === undefined ? {} : { maxPixels }),
  };
  const before = await renderSceneImage(snapshot, common);
  const after = await renderSceneImage(snapshot, { ...common, cellsOverride: override });
  const diff = await renderSceneImage(snapshot, { ...common, cellsOverride: override, highlights });
  const artifacts: PreviewArtifacts = {
    beforePng: path.join(outputDirectory, "before.png"),
    afterPng: path.join(outputDirectory, "after.png"),
    diffPng: path.join(outputDirectory, "diff.png"),
    reportHtml: path.join(outputDirectory, "report.html"),
  };
  await Promise.all([
    writeFile(artifacts.beforePng, before.png),
    writeFile(artifacts.afterPng, after.png),
    writeFile(artifacts.diffPng, diff.png),
  ]);
  const totalChanges = edits.reduce((sum, edit) => sum + edit.changes.length, 0);
  const rows = edits.map((edit) => `<tr><td>${xmlEscape(edit.layer)}</td><td>${edit.changes.length}</td></tr>`).join("");
  await writeFile(artifacts.reportHtml, `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>TileMap edit preview</title><style>body{font:15px system-ui;background:#0b1020;color:#e5e7eb;max-width:1100px;margin:0 auto;padding:28px}h1{font-size:24px}img{max-width:100%;image-rendering:pixelated;border:1px solid #334155;background:#111827}section{margin:28px 0}table{border-collapse:collapse}td,th{padding:8px 12px;border:1px solid #334155;text-align:left}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:18px}</style><h1>TileMap edit preview</h1><p>${totalChanges} changed cell(s) across ${edits.length} layer(s).</p><table><thead><tr><th>Layer</th><th>Changes</th></tr></thead><tbody>${rows}</tbody></table><div class="grid"><section><h2>Before</h2><img src="before.png" alt="Before"></section><section><h2>After</h2><img src="after.png" alt="After"></section></div><section><h2>Diff</h2><p>Green: added · red: erased · amber: replaced.</p><img src="diff.png" alt="Diff"></section></html>`, "utf8");
  return artifacts;
}

export function cellsAfterEdits(snapshot: SceneSnapshot, edits: LayerEditResult[]): Map<string, TileCell[]> {
  const result = new Map(snapshot.layers.map((layer) => [layer.descriptor.fullPath, layer.cells]));
  for (const edit of edits) result.set(edit.layer, decodeTileMapData(edit.nextBase64).cells);
  return result;
}

export function cellLookup(cells: TileCell[]): Map<string, TileCell> {
  return new Map(cells.map((cell) => [cellKey(cell.x, cell.y), cell]));
}
