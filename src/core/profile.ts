import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { BrushDefinition, TileRef } from "./types.js";

const tileRefSchema = z.object({
  source_id: z.number().int().min(0).max(65535),
  atlas_x: z.number().int().min(0).max(65535),
  atlas_y: z.number().int().min(0).max(65535),
  alternative_id: z.number().int().min(0).max(65535).default(0),
});

const selectorSchema = z.union([
  tileRefSchema,
  z.object({ alias: z.string().min(1) }),
]);

export const projectProfileSchema = z.object({
  $schema: z.string().optional(),
  version: z.literal(1),
  layer_roles: z.record(z.string(), z.array(z.string())).default({}),
  protected_layers: z.array(z.string()).default([]),
  tilesets: z.record(z.string(), z.object({
    aliases: z.record(z.string(), tileRefSchema).default({}),
    brushes: z.record(z.string(), z.object({
      tiles: z.array(z.object({ tile: selectorSchema, weight: z.number().positive().optional() })).min(1),
    })).default({}),
  })).default({}),
  analysis: z.object({
    walkability_layer_role: z.string().optional(),
    walk_mask_custom_data: z.string().optional(),
    force_block_custom_data: z.string().optional(),
  }).default({}),
  limits: z.object({
    max_cells_per_edit: z.number().int().positive().max(1_000_000).default(50_000),
    max_render_pixels: z.number().int().positive().max(100_000_000).default(16_777_216),
  }).default({ max_cells_per_edit: 50_000, max_render_pixels: 16_777_216 }),
  extensions: z.record(z.string(), z.unknown()).default({}),
});

export type RawProjectProfile = z.infer<typeof projectProfileSchema>;

export interface ProjectProfile {
  raw: RawProjectProfile;
  aliases: Map<string, TileRef>;
  brushes: Map<string, BrushDefinition>;
}

function convertTileRef(raw: z.infer<typeof tileRefSchema>): TileRef {
  return {
    sourceId: raw.source_id,
    atlasX: raw.atlas_x,
    atlasY: raw.atlas_y,
    alternativeId: raw.alternative_id,
  };
}

export function hydrateProfile(raw: RawProjectProfile): ProjectProfile {
  const aliases = new Map<string, TileRef>();
  const brushes = new Map<string, BrushDefinition>();
  for (const tileSet of Object.values(raw.tilesets)) {
    for (const [name, tile] of Object.entries(tileSet.aliases)) aliases.set(name, convertTileRef(tile));
    for (const [name, brush] of Object.entries(tileSet.brushes)) {
      brushes.set(name, {
        tiles: brush.tiles.map((entry) => ({
          tile: "alias" in entry.tile
            ? { alias: entry.tile.alias }
            : convertTileRef(entry.tile),
          ...(entry.weight === undefined ? {} : { weight: entry.weight }),
        })),
      });
    }
  }
  return { raw, aliases, brushes };
}

export async function loadProjectProfile(projectPath: string): Promise<ProjectProfile | null> {
  const profilePath = path.join(projectPath, ".godot-tilemap-mcp.json");
  try {
    const parsed = projectProfileSchema.parse(JSON.parse(await readFile(profilePath, "utf8")));
    return hydrateProfile(parsed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Invalid ${profilePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function defaultProjectProfile(): RawProjectProfile {
  return projectProfileSchema.parse({ version: 1 });
}

export async function writeDefaultProjectProfile(projectPath: string): Promise<string> {
  const profilePath = path.join(projectPath, ".godot-tilemap-mcp.json");
  const raw = defaultProjectProfile();
  raw.$schema = "https://raw.githubusercontent.com/Ekaitzsegurola/godot-tilemap-mcp/main/schemas/project-profile.schema.json";
  await writeFile(profilePath, `${JSON.stringify(raw, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return profilePath;
}

export function layerMatches(pattern: string, fullPath: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(fullPath) || fullPath.endsWith(pattern.replace(/^\*+\//, ""));
}

export function isLayerProtected(profile: ProjectProfile | null, fullPath: string): boolean {
  return profile?.raw.protected_layers.some((pattern) => layerMatches(pattern, fullPath)) ?? false;
}
