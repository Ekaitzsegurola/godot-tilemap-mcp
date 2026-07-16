import { z } from "zod";
import type { EditRecipe } from "./types.js";

const coordinate = z.number().int().min(-32768).max(32767);
export const pointSchema = z.object({ x: coordinate, y: coordinate });
export const regionSchema = pointSchema.extend({
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
export const tileRefSchema = z.object({
  sourceId: z.number().int().min(0).max(65535),
  atlasX: z.number().int().min(0).max(65535),
  atlasY: z.number().int().min(0).max(65535),
  alternativeId: z.number().int().min(0).max(65535).default(0),
});
export const tileSelectorSchema = z.union([
  tileRefSchema,
  z.object({ alias: z.string().min(1) }),
  z.object({ brush: z.string().min(1) }),
]);

const shapeSchema = z.discriminatedUnion("kind", [
  regionSchema.extend({ kind: z.literal("rect") }),
  regionSchema.extend({ kind: z.literal("ellipse") }),
  z.object({ kind: z.literal("polygon"), points: z.array(pointSchema).min(3) }),
  z.object({ kind: z.literal("cells"), cells: z.array(pointSchema) }),
]);

export const editOperationSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("set"),
    layer: z.string().min(1),
    cells: z.array(pointSchema.extend({ tile: tileSelectorSchema })).min(1),
  }),
  z.object({ op: z.literal("erase"), layer: z.string().min(1), shape: shapeSchema }),
  z.object({ op: z.literal("fill"), layer: z.string().min(1), shape: shapeSchema, tile: tileSelectorSchema }),
  z.object({
    op: z.literal("flood_fill"),
    layer: z.string().min(1),
    start: pointSchema,
    tile: tileSelectorSchema,
    maxCells: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal("path"),
    layer: z.string().min(1),
    points: z.array(pointSchema).min(2),
    tile: tileSelectorSchema,
    width: z.number().int().positive().optional(),
    jitter: z.number().min(0).optional(),
  }),
  z.object({
    op: z.literal("scatter"),
    layer: z.string().min(1),
    region: regionSchema,
    tile: tileSelectorSchema,
    density: z.number().min(0).max(1),
    minDistance: z.number().min(0).optional(),
  }),
  z.object({
    op: z.literal("replace"),
    layer: z.string().min(1),
    region: regionSchema.optional(),
    from: tileSelectorSchema,
    to: tileSelectorSchema,
  }),
  z.object({
    op: z.literal("stamp"),
    layer: z.string().min(1),
    origin: pointSchema,
    pattern: z.array(z.string()).min(1),
    palette: z.record(z.string(), tileSelectorSchema),
  }),
  z.object({
    op: z.literal("copy"),
    layer: z.string().min(1),
    source: regionSchema,
    destination: pointSchema,
    flipX: z.boolean().optional(),
    flipY: z.boolean().optional(),
    rotate: z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]).optional(),
  }),
  z.object({
    op: z.literal("terrain_connect"),
    layer: z.string().min(1),
    cells: z.array(pointSchema).min(1),
    terrainSet: z.number().int().min(0),
    terrain: z.number().int().min(0),
    ignoreEmptyTerrains: z.boolean().optional(),
  }),
  z.object({
    op: z.literal("terrain_path"),
    layer: z.string().min(1),
    points: z.array(pointSchema).min(2),
    terrainSet: z.number().int().min(0),
    terrain: z.number().int().min(0),
    ignoreEmptyTerrains: z.boolean().optional(),
  }),
]);

export const editRecipeSchema = z.object({
  scenePath: z.string().min(1),
  projectPath: z.string().min(1).optional(),
  seed: z.string().optional(),
  operations: z.array(editOperationSchema).min(1),
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  includePreview: z.boolean().optional(),
});

export function parseEditRecipe(value: unknown): EditRecipe {
  return editRecipeSchema.parse(value) as EditRecipe;
}
