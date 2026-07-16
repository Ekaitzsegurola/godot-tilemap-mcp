import path from "node:path";
import { loadGodotText, type GodotProperty, type GodotSection, type GodotTextDocument } from "./godotText.js";
import type {
  CatalogTile,
  CustomDataLayer,
  LayerDescriptor,
  Point,
  TerrainDefinition,
  TileSetCatalog,
  TileSetSourceCatalog,
} from "./types.js";
import type { ProjectPaths } from "./paths.js";

function getProperty(section: GodotSection, key: string): string | null {
  return section.properties.find((property) => property.key === key)?.value ?? null;
}

function parsePoint(raw: string | null, fallback: Point = { x: 0, y: 0 }): Point {
  const match = raw?.match(/Vector2i?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { ...fallback };
}

export function parseGodotValue(raw: string): unknown {
  const value = raw.trim();
  if (value === "true") return true;
  if (value === "false") return false;
  if (value === "null") return null;
  if (/^-?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^-?(?:\d+\.\d*|\d*\.\d+)(?:e[+-]?\d+)?$/i.test(value)) return Number.parseFloat(value);
  const point = value.match(/Vector2i?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  if (point) return { x: Number(point[1]), y: Number(point[2]) };
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function externalResources(document: GodotTextDocument): Map<string, { path: string; type: string }> {
  const map = new Map<string, { path: string; type: string }>();
  for (const section of document.sections) {
    if (section.type !== "ext_resource" || !section.attrs.id || !section.attrs.path) continue;
    map.set(section.attrs.id, { path: section.attrs.path, type: section.attrs.type ?? "" });
  }
  return map;
}

function subresources(document: GodotTextDocument): Map<string, GodotSection> {
  const map = new Map<string, GodotSection>();
  for (const section of document.sections) {
    if (section.type === "sub_resource" && section.attrs.id) map.set(section.attrs.id, section);
  }
  return map;
}

function resourceName(section: GodotSection): string | null {
  const raw = getProperty(section, "resource_name");
  const value = raw ? parseGodotValue(raw) : null;
  return typeof value === "string" ? value : null;
}

function resolveExternalPath(raw: string | null, resources: Map<string, { path: string; type: string }>): string | null {
  if (!raw) return null;
  const match = raw.match(/ExtResource\("([^"]+)"\)/);
  return match ? resources.get(match[1]!)?.path ?? null : null;
}

function customDataLayers(resource: GodotSection): CustomDataLayer[] {
  const byIndex = new Map<number, CustomDataLayer>();
  for (const property of resource.properties) {
    const match = property.key.match(/^custom_data_layer_(\d+)\/(name|type)$/);
    if (!match) continue;
    const index = Number(match[1]);
    const existing = byIndex.get(index) ?? { index, name: `custom_data_${index}`, variantType: null };
    if (match[2] === "name") {
      const value = parseGodotValue(property.value);
      if (typeof value === "string") existing.name = value;
    } else {
      const value = parseGodotValue(property.value);
      if (typeof value === "number") existing.variantType = value;
    }
    byIndex.set(index, existing);
  }
  return [...byIndex.values()].sort((left, right) => left.index - right.index);
}

function terrainDefinitions(resource: GodotSection): TerrainDefinition[] {
  const definitions = new Map<string, TerrainDefinition>();
  for (const property of resource.properties) {
    const match = property.key.match(/^terrain_set_(\d+)\/(?:terrain_(\d+)|terrains\/(\d+))\/(name|color)$/);
    if (!match) continue;
    const setId = Number(match[1]);
    const terrainId = Number(match[2] ?? match[3]);
    const key = `${setId}:${terrainId}`;
    const existing = definitions.get(key) ?? { setId, terrainId, name: `terrain_${terrainId}`, color: null };
    const value = parseGodotValue(property.value);
    if (match[4] === "name" && typeof value === "string") existing.name = value;
    if (match[4] === "color") existing.color = property.value;
    definitions.set(key, existing);
  }
  return [...definitions.values()].sort((left, right) => left.setId - right.setId || left.terrainId - right.terrainId);
}

function countLayerProperties(resource: GodotSection, prefix: string): number {
  const indexes = new Set<number>();
  for (const property of resource.properties) {
    const match = property.key.match(new RegExp(`^${prefix}_(\\d+)/`));
    if (match) indexes.add(Number(match[1]));
  }
  return indexes.size;
}

function tileAlias(sourceId: number, sourceName: string | null, atlasX: number, atlasY: number, alternativeId: number): string {
  const prefix = (sourceName ?? `source_${sourceId}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${prefix || `source_${sourceId}`}_${atlasX}_${atlasY}${alternativeId === 0 ? "" : `_alt_${alternativeId}`}`;
}

function tilePropertiesFor(section: GodotSection): Map<string, GodotProperty[]> {
  const grouped = new Map<string, GodotProperty[]>();
  for (const property of section.properties) {
    const match = property.key.match(/^(\d+):(\d+)\/(\d+)(?:\/(.+))?$/);
    if (!match) continue;
    const key = `${match[1]}:${match[2]}/${match[3]}`;
    const values = grouped.get(key) ?? [];
    values.push(property);
    grouped.set(key, values);
  }
  return grouped;
}

function parseAtlasSource(
  section: GodotSection,
  sourceId: number,
  resources: Map<string, { path: string; type: string }>,
  layers: CustomDataLayer[],
): TileSetSourceCatalog {
  const name = resourceName(section);
  const texturePath = resolveExternalPath(getProperty(section, "texture"), resources);
  const textureRegionSize = parsePoint(getProperty(section, "texture_region_size"), { x: 16, y: 16 });
  const margins = parsePoint(getProperty(section, "margins"));
  const separation = parsePoint(getProperty(section, "separation"));
  const tiles: CatalogTile[] = [];

  for (const [key, properties] of tilePropertiesFor(section)) {
    const match = key.match(/^(\d+):(\d+)\/(\d+)$/)!;
    const atlasX = Number(match[1]);
    const atlasY = Number(match[2]);
    const alternativeId = Number(match[3]);
    const customData: Record<string, unknown> = {};
    const terrainPeering: Record<string, number> = {};
    const animation: Record<string, unknown> = {};
    let terrainSet: number | null = null;
    let terrain: number | null = null;
    let probability = 1;
    let hasPhysics = false;
    let hasNavigation = false;
    let sizeInAtlas: Point = { x: 1, y: 1 };

    for (const property of properties) {
      const suffix = property.key.slice(key.length + 1);
      if (!suffix) continue;
      const custom = suffix.match(/^custom_data_(\d+)$/);
      if (custom) {
        const index = Number(custom[1]);
        customData[layers.find((layer) => layer.index === index)?.name ?? `custom_data_${index}`] = parseGodotValue(property.value);
      } else if (suffix === "terrain_set") {
        const value = parseGodotValue(property.value);
        if (typeof value === "number") terrainSet = value;
      } else if (suffix === "terrain") {
        const value = parseGodotValue(property.value);
        if (typeof value === "number") terrain = value;
      } else if (suffix.startsWith("terrains_peering_bit/")) {
        const value = parseGodotValue(property.value);
        if (typeof value === "number") terrainPeering[suffix.slice("terrains_peering_bit/".length)] = value;
      } else if (suffix === "probability") {
        const value = parseGodotValue(property.value);
        if (typeof value === "number") probability = value;
      } else if (suffix === "size_in_atlas") {
        sizeInAtlas = parsePoint(property.value, { x: 1, y: 1 });
      } else if (suffix.startsWith("animation_")) {
        animation[suffix] = parseGodotValue(property.value);
      } else if (suffix.startsWith("physics_layer_")) {
        hasPhysics = true;
      } else if (suffix.startsWith("navigation_layer_")) {
        hasNavigation = true;
      }
    }

    tiles.push({
      sourceId,
      atlasX,
      atlasY,
      alternativeId,
      sourceName: name,
      texturePath,
      textureRegionSize,
      margins,
      separation,
      sizeInAtlas,
      customData,
      terrainSet,
      terrain,
      terrainPeering,
      probability,
      animation,
      hasPhysics,
      hasNavigation,
      alias: tileAlias(sourceId, name ?? (texturePath ? path.basename(texturePath, path.extname(texturePath)) : null), atlasX, atlasY, alternativeId),
    });
  }

  return {
    sourceId,
    kind: "atlas",
    resourceName: name,
    texturePath,
    textureRegionSize,
    margins,
    separation,
    tiles: tiles.sort((left, right) => left.atlasY - right.atlasY || left.atlasX - right.atlasX || left.alternativeId - right.alternativeId),
    scenes: [],
  };
}

function parseSceneSource(
  section: GodotSection,
  sourceId: number,
  resources: Map<string, { path: string; type: string }>,
): TileSetSourceCatalog {
  const scenes: Array<{ id: number; path: string | null }> = [];
  for (const property of section.properties) {
    const match = property.key.match(/^(\d+)\/scene$/);
    if (!match) continue;
    scenes.push({ id: Number(match[1]), path: resolveExternalPath(property.value, resources) });
  }
  return {
    sourceId,
    kind: "scenes",
    resourceName: resourceName(section),
    texturePath: null,
    textureRegionSize: { x: 16, y: 16 },
    margins: { x: 0, y: 0 },
    separation: { x: 0, y: 0 },
    tiles: [],
    scenes,
  };
}

export async function inspectTileSet(
  filePath: string,
  options: { resourceKey?: string; subresourceId?: string | null } = {},
): Promise<TileSetCatalog> {
  const document = await loadGodotText(filePath);
  const resources = externalResources(document);
  const subs = subresources(document);
  const subresourceId = options.subresourceId ?? null;
  const resource = subresourceId
    ? subs.get(subresourceId)
    : document.sections.find((section) => section.type === "resource");
  if (!resource || (subresourceId && resource.attrs.type !== "TileSet")) {
    throw new Error(`TileSet resource ${subresourceId ?? "[resource]"} not found in ${filePath}`);
  }

  const layers = customDataLayers(resource);
  const sources: TileSetSourceCatalog[] = [];
  const warnings: string[] = [];
  for (const property of resource.properties) {
    const sourceMatch = property.key.match(/^sources\/(\d+)$/);
    if (!sourceMatch) continue;
    const sourceId = Number(sourceMatch[1]);
    const subMatch = property.value.match(/SubResource\("([^"]+)"\)/);
    if (!subMatch) {
      warnings.push(`Source ${sourceId} is not an embedded SubResource and could not be inspected statically.`);
      continue;
    }
    const section = subs.get(subMatch[1]!);
    if (!section) {
      warnings.push(`Source ${sourceId} references missing SubResource ${subMatch[1]}.`);
      continue;
    }
    if (section.attrs.type === "TileSetAtlasSource") sources.push(parseAtlasSource(section, sourceId, resources, layers));
    else if (section.attrs.type === "TileSetScenesCollectionSource") sources.push(parseSceneSource(section, sourceId, resources));
    else {
      sources.push({
        sourceId,
        kind: "unknown",
        resourceName: resourceName(section),
        texturePath: null,
        textureRegionSize: { x: 16, y: 16 },
        margins: { x: 0, y: 0 },
        separation: { x: 0, y: 0 },
        tiles: [],
        scenes: [],
      });
    }
  }
  sources.sort((left, right) => left.sourceId - right.sourceId);

  return {
    resourceKey: options.resourceKey ?? filePath,
    filePath,
    subresourceId,
    tileSize: parsePoint(getProperty(resource, "tile_size"), { x: 16, y: 16 }),
    tileShape: Number(parseGodotValue(getProperty(resource, "tile_shape") ?? "0")),
    tileLayout: Number(parseGodotValue(getProperty(resource, "tile_layout") ?? "0")),
    tileOffsetAxis: Number(parseGodotValue(getProperty(resource, "tile_offset_axis") ?? "0")),
    customDataLayers: layers,
    terrains: terrainDefinitions(resource),
    physicsLayerCount: countLayerProperties(resource, "physics_layer"),
    navigationLayerCount: countLayerProperties(resource, "navigation_layer"),
    sources,
    tiles: sources.flatMap((source) => source.tiles),
    warnings,
  };
}

export async function inspectLayerTileSet(
  paths: ProjectPaths,
  project: string,
  scenePath: string,
  layer: LayerDescriptor,
): Promise<TileSetCatalog | null> {
  if (layer.tileSetKind === "external" && layer.tileSetPath) {
    return inspectTileSet(paths.resolveResourcePath(project, layer.tileSetPath), { resourceKey: layer.tileSetPath });
  }
  if (layer.tileSetKind === "embedded" && layer.tileSetId) {
    const resourcePath = paths.toResourcePath(project, scenePath);
    return inspectTileSet(scenePath, { resourceKey: `${resourcePath}#${layer.tileSetId}`, subresourceId: layer.tileSetId });
  }
  return null;
}
