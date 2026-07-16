import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { decodeTileMapData } from "./tileData.js";
import { findTileMapLayers, loadGodotText, resolveLayer } from "./godotText.js";
import { shouldIgnoreDirectory, type ProjectPaths } from "./paths.js";
import { inspectLayerTileSet } from "./tileset.js";
import type { Bounds, LayerDescriptor, TileCell, TileSetCatalog } from "./types.js";
import { calculateBounds } from "./types.js";

export interface LayerSnapshot {
  descriptor: LayerDescriptor;
  formatVersion: number;
  cells: TileCell[];
  bounds: Bounds | null;
  tileSet: TileSetCatalog | null;
}

export interface SceneSnapshot {
  project: string;
  scenePath: string;
  resourcePath: string;
  revision: string;
  text: string;
  layers: LayerSnapshot[];
}

export function revisionForText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

async function scan(directory: string, extension: string, output: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const filePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!shouldIgnoreDirectory(entry.name)) await scan(filePath, extension, output);
    } else if (entry.isFile() && entry.name.endsWith(extension)) {
      output.push(filePath);
    }
  }
}

export async function listTilemapScenes(paths: ProjectPaths, projectPath?: string): Promise<Array<{
  scene: string;
  absolutePath: string;
  layers: Array<LayerDescriptor & { tileCount: number; bounds: Bounds | null }>;
}>> {
  const project = await paths.resolveProject(projectPath);
  const files: string[] = [];
  await scan(project, ".tscn", files);
  const result = [];
  for (const filePath of files.sort()) {
    const text = await readFile(filePath, "utf8");
    if (!text.includes('type="TileMapLayer"')) continue;
    const document = await loadGodotText(filePath);
    const layers = findTileMapLayers(document);
    if (layers.length === 0) continue;
    result.push({
      scene: paths.toResourcePath(project, filePath),
      absolutePath: filePath,
      layers: layers.map((layer) => {
        const cells = decodeTileMapData(layer.tileMapDataBase64).cells;
        return { ...layer, tileCount: cells.length, bounds: calculateBounds(cells) };
      }),
    });
  }
  return result;
}

export async function loadSceneSnapshot(
  paths: ProjectPaths,
  sceneInput: string,
  options: { projectPath?: string; layers?: string[]; includeTileSets?: boolean } = {},
): Promise<SceneSnapshot> {
  const resolved = await paths.resolveFile(sceneInput, options.projectPath);
  if (!resolved.file.endsWith(".tscn")) throw new Error("Transactional editing currently supports text .tscn scenes only");
  const text = await readFile(resolved.file, "utf8");
  const document = await loadGodotText(resolved.file);
  const descriptors = findTileMapLayers(document);
  const selected = options.layers?.length
    ? options.layers.map((name) => resolveLayer(descriptors, name))
    : descriptors;
  const layers: LayerSnapshot[] = [];
  for (const descriptor of selected) {
    const decoded = decodeTileMapData(descriptor.tileMapDataBase64);
    layers.push({
      descriptor,
      formatVersion: decoded.formatVersion,
      cells: decoded.cells,
      bounds: calculateBounds(decoded.cells),
      tileSet: options.includeTileSets === false
        ? null
        : await inspectLayerTileSet(paths, resolved.project, resolved.file, descriptor),
    });
  }
  return {
    project: resolved.project,
    scenePath: resolved.file,
    resourcePath: paths.toResourcePath(resolved.project, resolved.file),
    revision: revisionForText(text),
    text,
    layers,
  };
}

export function getLayerSnapshot(snapshot: SceneSnapshot, layerName: string): LayerSnapshot {
  const descriptor = resolveLayer(snapshot.layers.map((layer) => layer.descriptor), layerName);
  return snapshot.layers.find((layer) => layer.descriptor.fullPath === descriptor.fullPath)!;
}
