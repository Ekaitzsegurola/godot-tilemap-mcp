import { readFile } from "node:fs/promises";
import type { LayerDescriptor, Point } from "./types.js";

export interface GodotProperty {
  key: string;
  value: string;
  lineStart: number;
  contentEnd: number;
  lineEnd: number;
}

export interface GodotSection {
  type: string;
  attrs: Record<string, string>;
  header: string;
  start: number;
  end: number;
  headerLineEnd: number;
  properties: GodotProperty[];
}

export interface GodotTextDocument {
  text: string;
  sections: GodotSection[];
  newline: "\n" | "\r\n" | "\r";
  hasBom: boolean;
}

interface TextLine {
  content: string;
  start: number;
  contentEnd: number;
  end: number;
}

const HEADER_PATTERN = /^\[([A-Za-z_][A-Za-z0-9_]*)(?:\s+(.*))?\]\s*$/;
const PROPERTY_PATTERN = /^([^\s=]+)\s*=\s*(.*)$/;

function splitLines(text: string): TextLine[] {
  const lines: TextLine[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let contentEnd = cursor;
    while (contentEnd < text.length && text[contentEnd] !== "\n" && text[contentEnd] !== "\r") {
      contentEnd++;
    }
    let end = contentEnd;
    if (text[end] === "\r" && text[end + 1] === "\n") end += 2;
    else if (text[end] === "\r" || text[end] === "\n") end += 1;
    lines.push({ content: text.slice(cursor, contentEnd), start: cursor, contentEnd, end });
    cursor = end;
  }
  if (text.length === 0) lines.push({ content: "", start: 0, contentEnd: 0, end: 0 });
  return lines;
}

export function parseHeaderAttributes(input: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=("(?:[^"\\]|\\.)*"|[^\s]+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    const key = match[1]!;
    const raw = match[2]!;
    attributes[key] = raw.startsWith('"')
      ? raw.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\")
      : raw;
  }
  return attributes;
}

export function parseGodotText(text: string): GodotTextDocument {
  const newline: GodotTextDocument["newline"] = text.includes("\r\n")
    ? "\r\n"
    : text.includes("\r")
      ? "\r"
      : "\n";
  const lines = splitLines(text);
  const sections: GodotSection[] = [];
  let current: GodotSection | null = null;

  for (const line of lines) {
    const normalized = line.content.startsWith("\uFEFF") ? line.content.slice(1) : line.content;
    const headerMatch = normalized.match(HEADER_PATTERN);
    if (headerMatch) {
      if (current) current.end = line.start;
      current = {
        type: headerMatch[1]!,
        attrs: parseHeaderAttributes(headerMatch[2] ?? ""),
        header: normalized,
        start: line.start,
        end: text.length,
        headerLineEnd: line.end,
        properties: [],
      };
      sections.push(current);
      continue;
    }

    if (!current || normalized.trim().length === 0) continue;
    const propertyMatch = normalized.match(PROPERTY_PATTERN);
    if (!propertyMatch) continue;
    current.properties.push({
      key: propertyMatch[1]!,
      value: propertyMatch[2]!,
      lineStart: line.start,
      contentEnd: line.contentEnd,
      lineEnd: line.end,
    });
  }

  return { text, sections, newline, hasBom: text.charCodeAt(0) === 0xfeff };
}

export async function loadGodotText(filePath: string): Promise<GodotTextDocument> {
  return parseGodotText(await readFile(filePath, "utf8"));
}

export function buildExternalResourceMap(document: GodotTextDocument): Map<string, { type: string; path: string | null; uid: string | null }> {
  const resources = new Map<string, { type: string; path: string | null; uid: string | null }>();
  for (const section of document.sections) {
    if (section.type !== "ext_resource" || !section.attrs.id) continue;
    resources.set(section.attrs.id, {
      type: section.attrs.type ?? "",
      path: section.attrs.path ?? null,
      uid: section.attrs.uid ?? null,
    });
  }
  return resources;
}

function parseBoolean(value: string, fallback: boolean): boolean {
  if (value.trim() === "true") return true;
  if (value.trim() === "false") return false;
  return fallback;
}

function parsePoint(value: string): Point {
  const match = value.match(/Vector2i?\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)/);
  return match ? { x: Number(match[1]), y: Number(match[2]) } : { x: 0, y: 0 };
}

function propertyValue(section: GodotSection, key: string): string | null {
  return section.properties.find((property) => property.key === key)?.value ?? null;
}

function normalizeNodePath(parent: string, name: string): string {
  if (!parent || parent === ".") return name;
  return `${parent}/${name}`;
}

export function findTileMapLayers(document: GodotTextDocument): LayerDescriptor[] {
  const externalResources = buildExternalResourceMap(document);
  const result: LayerDescriptor[] = [];
  for (const section of document.sections) {
    if (section.type !== "node" || section.attrs.type !== "TileMapLayer") continue;
    const name = section.attrs.name ?? "TileMapLayer";
    const parent = section.attrs.parent ?? "";
    const fullPath = normalizeNodePath(parent, name);
    const rawData = propertyValue(section, "tile_map_data");
    const dataMatch = rawData?.match(/PackedByteArray\(\s*(?:"([A-Za-z0-9+/=\s]*)")?\s*\)/);
    const rawTileSet = propertyValue(section, "tile_set");
    const externalMatch = rawTileSet?.match(/ExtResource\("([^"]+)"\)/);
    const embeddedMatch = rawTileSet?.match(/SubResource\("([^"]+)"\)/);
    const externalId = externalMatch?.[1] ?? null;
    const external = externalId ? externalResources.get(externalId) : null;
    result.push({
      name,
      parent,
      fullPath,
      nodePath: fullPath,
      tileMapDataBase64: dataMatch ? (dataMatch[1] ?? "").replace(/\s+/g, "") : null,
      tileSetKind: externalId ? "external" : embeddedMatch ? "embedded" : null,
      tileSetId: externalId ?? embeddedMatch?.[1] ?? null,
      tileSetPath: external?.path ?? null,
      zIndex: Number.parseInt(propertyValue(section, "z_index") ?? "0", 10) || 0,
      visible: parseBoolean(propertyValue(section, "visible") ?? "true", true),
      enabled: parseBoolean(propertyValue(section, "enabled") ?? "true", true),
      position: parsePoint(propertyValue(section, "position") ?? "Vector2(0, 0)"),
    });
  }
  return result;
}

export function resolveLayer(layers: LayerDescriptor[], layerName: string): LayerDescriptor {
  if (layerName.includes("/")) {
    const matches = layers.filter((layer) => layer.fullPath === layerName || layer.fullPath.endsWith(`/${layerName}`));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Layer path "${layerName}" is ambiguous: ${matches.map((layer) => layer.fullPath).join(", ")}`);
    }
  } else {
    const matches = layers.filter((layer) => layer.name === layerName);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new Error(`Layer name "${layerName}" is ambiguous. Use one of: ${matches.map((layer) => layer.fullPath).join(", ")}`);
    }
  }
  throw new Error(`Layer "${layerName}" not found. Available: ${layers.map((layer) => layer.fullPath).join(", ")}`);
}

export function getSectionForLayer(document: GodotTextDocument, layer: LayerDescriptor): GodotSection {
  const section = document.sections.find((candidate) => {
    if (candidate.type !== "node" || candidate.attrs.type !== "TileMapLayer") return false;
    return normalizeNodePath(candidate.attrs.parent ?? "", candidate.attrs.name ?? "TileMapLayer") === layer.fullPath;
  });
  if (!section) throw new Error(`Internal error: section for layer "${layer.fullPath}" not found`);
  return section;
}

export function patchTileMapData(
  document: GodotTextDocument,
  patches: Array<{ layer: LayerDescriptor; base64?: string | null; rawLine?: string | null }>,
): string {
  const replacements: Array<{ start: number; end: number; value: string }> = [];
  for (const patch of patches) {
    const section = getSectionForLayer(document, patch.layer);
    const property = section.properties.find((candidate) => candidate.key === "tile_map_data");
    const usesRawLine = Object.prototype.hasOwnProperty.call(patch, "rawLine");
    const line = usesRawLine
      ? patch.rawLine
      : patch.base64 === null
        ? null
        : `tile_map_data = PackedByteArray("${patch.base64 ?? ""}")`;
    if (property) {
      replacements.push({
        start: property.lineStart,
        end: line === null ? property.lineEnd : property.contentEnd,
        value: line ?? "",
      });
      continue;
    }
    if (line === null) continue;
    const tileSetProperty = section.properties.find((candidate) => candidate.key === "tile_set");
    const insertAt = tileSetProperty?.lineEnd ?? section.headerLineEnd;
    const needsLeadingNewline = insertAt === section.headerLineEnd && !document.text.slice(section.start, insertAt).endsWith(document.newline);
    replacements.push({
      start: insertAt,
      end: insertAt,
      value: `${needsLeadingNewline ? document.newline : ""}${line}${document.newline}`,
    });
  }

  replacements.sort((left, right) => right.start - left.start);
  let output = document.text;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
  }
  return output;
}

// Compatibility aliases for v1 consumers.
export const parseTscnText = parseGodotText;
export const parseTscn = loadGodotText;
export const buildExtResourceMap = buildExternalResourceMap;
