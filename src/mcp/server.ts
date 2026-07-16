import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  TransactionStore,
  analyzeLayer,
  decodeTileMapData,
  detectGodotExecutable,
  editRecipeSchema,
  extractPattern,
  findCatalogTiles,
  getLayerSnapshot,
  inspectTileSet,
  listTilemapScenes,
  loadProjectProfile,
  loadSceneSnapshot,
  parseEditRecipe,
  renderCatalogImage,
  renderSceneImage,
  resolveLayer,
  type EditRecipe,
  type Region,
  type TileRef,
  type TileSetCatalog,
} from "../core/index.js";
import { ProjectPaths } from "../core/paths.js";

export interface TilemapMcpOptions {
  projectPath: string;
  allowedRoots?: string[];
  legacyDirectWrites?: boolean;
  godotPath?: string;
}

const projectPathField = z.string().min(1).optional().describe("Optional Godot project root. Absolute paths are recommended for worktrees.");
const scenePathField = z.string().min(1).describe("Scene path: absolute, relative to the project, or res://.");
const layerField = z.string().min(1).describe("TileMapLayer name or path-qualified node path.");
const regionSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});
const legacyTileSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  source_id: z.number().int().min(0).max(65535),
  atlas_x: z.number().int().min(0).max(65535),
  atlas_y: z.number().int().min(0).max(65535),
  alt: z.number().int().min(0).max(65535).default(0),
});
const transactionIdField = z.string().regex(/^tx_[0-9a-f-]{36}$/i);

function errorMessage(error: unknown): string {
  if (error instanceof z.ZodError) return error.issues.map((issue) => `${issue.path.join(".") || "input"}: ${issue.message}`).join("; ");
  return error instanceof Error ? error.message : String(error);
}

async function safe(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action();
  } catch (error) {
    return { content: [{ type: "text", text: errorMessage(error) }], isError: true };
  }
}

function jsonResult(value: unknown, image?: Buffer): CallToolResult {
  const object = value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : { data: value };
  const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(value, null, 2) }];
  if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
  return { content, structuredContent: object };
}

function transactionView(transaction: Awaited<ReturnType<TransactionStore["read"]>>): Record<string, unknown> {
  return {
    id: transaction.id,
    project_path: transaction.projectPath,
    scene_path: transaction.scenePath,
    base_revision: transaction.baseRevision,
    created_at: transaction.createdAt,
    expires_at: transaction.expiresAt,
    applied_revision: transaction.appliedRevision ?? null,
    applied_at: transaction.appliedAt ?? null,
    undone_revision: transaction.undoneRevision ?? null,
    undone_at: transaction.undoneAt ?? null,
    changed_cells: transaction.layers.reduce((sum, layer) => sum + layer.changes.length, 0),
    layers: transaction.layers.map((layer) => ({
      layer: layer.layer,
      changed_cells: layer.changes.length,
      bounds: layer.bounds,
      changes: layer.changes,
    })),
    warnings: transaction.warnings,
    preview: transaction.preview ?? null,
  };
}

function legacyRef(input: { source_id: number; atlas_x: number; atlas_y: number; alt?: number }): TileRef {
  return {
    sourceId: input.source_id,
    atlasX: input.atlas_x,
    atlasY: input.atlas_y,
    alternativeId: input.alt ?? 0,
  };
}

function legacyCell(cell: { x: number; y: number } & TileRef): Record<string, number> {
  return {
    x: cell.x,
    y: cell.y,
    source_id: cell.sourceId,
    atlas_x: cell.atlasX,
    atlas_y: cell.atlasY,
    alt: cell.alternativeId,
  };
}

function asciiRender(cells: Array<{ x: number; y: number } & TileRef>, region: Region | undefined, mode: "source" | "atlas"): string {
  if (cells.length === 0) return "(empty TileMapLayer)";
  const minX = region?.x ?? Math.min(...cells.map((cell) => cell.x));
  const minY = region?.y ?? Math.min(...cells.map((cell) => cell.y));
  const maxX = region ? region.x + region.width - 1 : Math.max(...cells.map((cell) => cell.x));
  const maxY = region ? region.y + region.height - 1 : Math.max(...cells.map((cell) => cell.y));
  if ((maxX - minX + 1) * (maxY - minY + 1) > 40_000) return "(region too large for ASCII; use render_tilemap_image)";
  const lookup = new Map(cells.map((cell) => [`${cell.x},${cell.y}`, cell]));
  const rows: string[] = [];
  for (let y = minY; y <= maxY; y++) {
    const row: string[] = [];
    for (let x = minX; x <= maxX; x++) {
      const cell = lookup.get(`${x},${y}`);
      if (!cell) row.push(mode === "atlas" ? "   ." : ".");
      else if (mode === "atlas") row.push(`${cell.atlasX}.${cell.atlasY}`.padStart(4));
      else row.push(cell.sourceId < 10 ? String(cell.sourceId) : String.fromCharCode(55 + Math.min(cell.sourceId, 35)));
    }
    rows.push(row.join(mode === "atlas" ? " " : ""));
  }
  return rows.join("\n");
}

async function catalogForInput(
  paths: ProjectPaths,
  input: { project_path?: string | undefined; tileset_path?: string | undefined; scene_path?: string | undefined; layer_name?: string | undefined },
): Promise<{ project: string; catalog: TileSetCatalog }> {
  if (input.tileset_path) {
    const resolved = await paths.resolveFile(input.tileset_path, input.project_path);
    return { project: resolved.project, catalog: await inspectTileSet(resolved.file, { resourceKey: paths.toResourcePath(resolved.project, resolved.file) }) };
  }
  if (!input.scene_path || !input.layer_name) throw new Error("Provide tileset_path, or both scene_path and layer_name");
  const snapshot = await loadSceneSnapshot(paths, input.scene_path, {
    ...(input.project_path === undefined ? {} : { projectPath: input.project_path }),
    layers: [input.layer_name],
  });
  const layer = getLayerSnapshot(snapshot, input.layer_name);
  if (!layer.tileSet) throw new Error(`Layer ${input.layer_name} has no inspectable TileSet`);
  return { project: snapshot.project, catalog: layer.tileSet };
}

async function legacyWrite(
  transactions: TransactionStore,
  recipe: EditRecipe,
  direct: boolean,
): Promise<CallToolResult> {
  const transaction = await transactions.preview(recipe);
  const previewImage = transaction.preview ? await readFile(transaction.preview.diffPng) : undefined;
  if (!direct) {
    return jsonResult({
      success: true,
      legacy_write_mode: "preview_only",
      message: "No scene file was modified. Review the diff, then call apply_tilemap_edit with transaction_id.",
      transaction: transactionView(transaction),
    }, previewImage);
  }
  const applied = await transactions.apply(transaction.id, transaction.projectPath);
  return jsonResult({ success: true, legacy_write_mode: "direct_opt_in", transaction: transactionView(applied) }, previewImage);
}

export async function createTilemapMcpServer(options: TilemapMcpOptions): Promise<McpServer> {
  const paths = await ProjectPaths.create(options.projectPath, options.allowedRoots ?? []);
  const transactions = new TransactionStore(paths, {
    ...(options.godotPath === undefined ? {} : { godotPath: options.godotPath }),
  });
  const server = new McpServer({ name: "godot-tilemap-mcp", version: "2.0.0" });
  const readOnly = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const previewWrite = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
  const sceneWrite = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false };

  server.registerTool("tilemap_doctor", {
    title: "Diagnose Godot tilemap project",
    description: "Validate project discovery, profile, Godot bridge availability, scenes, TileMapLayer data and TileSet references.",
    inputSchema: z.object({ project_path: projectPathField }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const project = await paths.resolveProject(args.project_path);
    const profile = await loadProjectProfile(project);
    const godot = await detectGodotExecutable(options.godotPath);
    const scenes = await listTilemapScenes(paths, project);
    const warnings = scenes.flatMap((scene) => scene.layers
      .filter((layer) => !layer.tileSetKind)
      .map((layer) => `${scene.scene}: ${layer.fullPath} has no TileSet reference`));
    return jsonResult({
      ok: warnings.length === 0,
      project,
      godot_bridge: godot,
      profile: profile ? path.join(project, ".godot-tilemap-mcp.json") : null,
      scene_count: scenes.length,
      layer_count: scenes.reduce((sum, scene) => sum + scene.layers.length, 0),
      warnings,
    });
  }));

  server.registerTool("list_tilemaps", {
    title: "List TileMapLayer scenes",
    description: "Scan a Godot project for text scenes containing TileMapLayer nodes, with counts and bounds.",
    inputSchema: z.object({ project_path: projectPathField }),
    annotations: readOnly,
  }, (args) => safe(async () => jsonResult(await listTilemapScenes(paths, args.project_path))));

  server.registerTool("inspect_tilemap", {
    title: "Inspect TileMapLayer scene",
    description: "Inspect scene revision, layer paths, cell bounds and semantic TileSet summaries without returning huge binary fields.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField.optional(), include_cells: z.boolean().default(false), cell_limit: z.number().int().positive().max(50_000).default(2_000) }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, {
      ...(args.project_path === undefined ? {} : { projectPath: args.project_path }),
      ...(args.layer_name === undefined ? {} : { layers: [args.layer_name] }),
    });
    return jsonResult({
      project: snapshot.project,
      scene_path: snapshot.resourcePath,
      revision: snapshot.revision,
      layers: snapshot.layers.map((layer) => ({
        ...layer.descriptor,
        tileMapDataBase64: undefined,
        tile_count: layer.cells.length,
        bounds: layer.bounds,
        tileset: layer.tileSet ? {
          resource: layer.tileSet.resourceKey,
          tile_size: layer.tileSet.tileSize,
          sources: layer.tileSet.sources.length,
          catalog_tiles: layer.tileSet.tiles.length,
          custom_data_layers: layer.tileSet.customDataLayers,
          terrains: layer.tileSet.terrains,
          warnings: layer.tileSet.warnings,
        } : null,
        ...(args.include_cells ? { cells: layer.cells.slice(0, args.cell_limit), truncated: layer.cells.length > args.cell_limit } : {}),
      })),
    });
  }));

  server.registerTool("inspect_tileset", {
    title: "Inspect Godot TileSet",
    description: "Build a semantic catalog from external .tres or a layer's external/embedded TileSet.",
    inputSchema: z.object({ project_path: projectPathField, tileset_path: z.string().min(1).optional(), scene_path: z.string().min(1).optional(), layer_name: z.string().min(1).optional(), include_tiles: z.boolean().default(true), tile_limit: z.number().int().positive().max(10_000).default(2_000) }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const { catalog } = await catalogForInput(paths, args);
    return jsonResult({ ...catalog, tiles: args.include_tiles ? catalog.tiles.slice(0, args.tile_limit) : undefined, truncated: args.include_tiles && catalog.tiles.length > args.tile_limit });
  }));

  server.registerTool("find_tiles", {
    title: "Search semantic tile catalog",
    description: "Find tiles by alias/source text, terrain, custom data and physics/navigation metadata; returns a visual contact sheet.",
    inputSchema: z.object({
      project_path: projectPathField,
      tileset_path: z.string().min(1).optional(),
      scene_path: z.string().min(1).optional(),
      layer_name: z.string().min(1).optional(),
      text: z.string().optional(),
      source_id: z.number().int().min(0).optional(),
      terrain_set: z.number().int().min(0).optional(),
      terrain: z.number().int().min(0).optional(),
      custom_data: z.record(z.string(), z.unknown()).optional(),
      has_physics: z.boolean().optional(),
      has_navigation: z.boolean().optional(),
      limit: z.number().int().positive().max(1_024).default(128),
    }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const { project, catalog } = await catalogForInput(paths, args);
    const matches = findCatalogTiles(catalog, {
      ...(args.text === undefined ? {} : { text: args.text }),
      ...(args.source_id === undefined ? {} : { sourceId: args.source_id }),
      ...(args.terrain_set === undefined ? {} : { terrainSet: args.terrain_set }),
      ...(args.terrain === undefined ? {} : { terrain: args.terrain }),
      ...(args.custom_data === undefined ? {} : { customData: args.custom_data }),
      ...(args.has_physics === undefined ? {} : { hasPhysics: args.has_physics }),
      ...(args.has_navigation === undefined ? {} : { hasNavigation: args.has_navigation }),
      limit: args.limit,
    });
    const image = await renderCatalogImage(project, catalog, matches, { maxTiles: args.limit });
    return jsonResult({ count: matches.length, tiles: matches }, image);
  }));

  server.registerTool("read_tiles", {
    title: "Read TileMapLayer cells",
    description: "Decode TileMapLayer cells. Legacy snake_case output is preserved for compatibility.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField, region: regionSchema.optional(), limit: z.number().int().positive().max(100_000).default(20_000) }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), layers: [args.layer_name], includeTileSets: false });
    const layer = getLayerSnapshot(snapshot, args.layer_name);
    const filtered = args.region ? layer.cells.filter((cell) => cell.x >= args.region!.x && cell.x < args.region!.x + args.region!.width && cell.y >= args.region!.y && cell.y < args.region!.y + args.region!.height) : layer.cells;
    return jsonResult({ layer: layer.descriptor.fullPath, tile_count: filtered.length, tiles: filtered.slice(0, args.limit).map(legacyCell), truncated: filtered.length > args.limit });
  }));

  server.registerTool("render_tilemap_image", {
    title: "Render TileMap as PNG",
    description: "Render one or more visible TileMapLayer nodes from real atlas textures, optionally cropped, scaled and gridded.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layers: z.array(z.string().min(1)).optional(), region: regionSchema.optional(), scale: z.number().min(0.25).max(16).default(1), background: z.string().default("checker"), grid: z.boolean().default(false) }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), ...(args.layers === undefined ? {} : { layers: args.layers }) });
    const profile = await loadProjectProfile(snapshot.project);
    const rendered = await renderSceneImage(snapshot, {
      ...(args.layers === undefined ? {} : { layers: args.layers }),
      ...(args.region === undefined ? {} : { region: args.region }),
      scale: args.scale,
      background: args.background,
      grid: args.grid,
      maxPixels: profile?.raw.limits.max_render_pixels ?? 16_777_216,
    });
    return jsonResult({ scene_path: snapshot.resourcePath, bounds: rendered.bounds, pixel_width: rendered.pixelWidth, pixel_height: rendered.pixelHeight, tile_size: rendered.tileSize, warnings: rendered.warnings }, rendered.png);
  }));

  server.registerTool("analyze_tilemap", {
    title: "Analyze TileMap quality",
    description: "Analyze distribution, entropy, repeated signatures, long runs, connected components, isolated cells and invalid references.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField, region: regionSchema.optional() }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), layers: [args.layer_name] });
    const profile = await loadProjectProfile(snapshot.project);
    return jsonResult(analyzeLayer(getLayerSnapshot(snapshot, args.layer_name), profile, args.region));
  }));

  server.registerTool("extract_tilemap_pattern", {
    title: "Extract reusable TileMap stamp",
    description: "Convert a rectangular map region into a deterministic ASCII stamp plus tile palette and semantic legend.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField, region: regionSchema }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), layers: [args.layer_name] });
    const layer = getLayerSnapshot(snapshot, args.layer_name);
    return jsonResult(extractPattern(layer.cells, args.region, layer.tileSet));
  }));

  server.registerTool("preview_tilemap_edit", {
    title: "Preview transactional TileMap edit",
    description: "Validate a deterministic recipe and create a revision-locked cell diff plus before/after/diff PNGs. Never modifies the scene.",
    inputSchema: z.object({ recipe: editRecipeSchema }),
    annotations: previewWrite,
  }, (args) => safe(async () => {
    const transaction = await transactions.preview(parseEditRecipe(args.recipe));
    const image = transaction.preview ? await readFile(transaction.preview.diffPng) : undefined;
    return jsonResult(transactionView(transaction), image);
  }));

  server.registerTool("apply_tilemap_edit", {
    title: "Apply previewed TileMap edit",
    description: "Atomically apply a preview transaction only if the scene revision still matches. Patches tile_map_data without reformatting the scene.",
    inputSchema: z.object({ transaction_id: transactionIdField, project_path: projectPathField }),
    annotations: sceneWrite,
  }, (args) => safe(async () => jsonResult(transactionView(await transactions.apply(args.transaction_id, args.project_path)))));

  server.registerTool("undo_tilemap_edit", {
    title: "Undo applied TileMap edit",
    description: "Restore an applied transaction only if no later edits changed the scene.",
    inputSchema: z.object({ transaction_id: transactionIdField, project_path: projectPathField }),
    annotations: sceneWrite,
  }, (args) => safe(async () => jsonResult(transactionView(await transactions.undo(args.transaction_id, args.project_path)))));

  server.registerTool("discard_tilemap_edit", {
    title: "Discard TileMap preview",
    description: "Remove an unapplied or already-undone transaction and its cached visual artifacts.",
    inputSchema: z.object({ transaction_id: transactionIdField, project_path: projectPathField }),
    annotations: previewWrite,
  }, (args) => safe(async () => {
    await transactions.discard(args.transaction_id, args.project_path);
    return jsonResult({ discarded: true, transaction_id: args.transaction_id });
  }));

  // v1 read aliases.
  server.registerTool("get_tilemap_info", {
    title: "Get TileMap info (v1 compatibility)",
    description: "Compatibility alias for inspecting TileMapLayer metadata.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField.optional() }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), ...(args.layer_name === undefined ? {} : { layers: [args.layer_name] }), includeTileSets: false });
    return jsonResult({ scene: snapshot.resourcePath, layers: snapshot.layers.map((layer) => ({ name: layer.descriptor.name, full_path: layer.descriptor.fullPath, tile_count: layer.cells.length, bounds: layer.bounds, tileset_path: layer.descriptor.tileSetPath, z_index: layer.descriptor.zIndex, visible: layer.descriptor.visible, position: layer.descriptor.position })) });
  }));

  server.registerTool("render_tilemap", {
    title: "Render TileMap ASCII (v1 compatibility)",
    description: "Small ASCII renderer kept for v1 clients. Prefer render_tilemap_image for visual work.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField, mode: z.enum(["source", "atlas"]).default("source"), region: regionSchema.optional() }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), layers: [args.layer_name], includeTileSets: false });
    const layer = getLayerSnapshot(snapshot, args.layer_name);
    const render = asciiRender(layer.cells, args.region, args.mode);
    return { content: [{ type: "text", text: `${render}\n\nBounds: ${JSON.stringify(args.region ?? layer.bounds)}  Tiles: ${layer.cells.length}` }], structuredContent: { render, bounds: args.region ?? layer.bounds, tile_count: layer.cells.length } };
  }));

  server.registerTool("analyze_tilemap_patterns", {
    title: "Analyze TileMap patterns (v1 compatibility)",
    description: "Compatibility alias for analyze_tilemap.",
    inputSchema: z.object({ project_path: projectPathField, scene_path: scenePathField, layer_name: layerField, region: regionSchema.optional() }),
    annotations: readOnly,
  }, (args) => safe(async () => {
    const snapshot = await loadSceneSnapshot(paths, args.scene_path, { ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), layers: [args.layer_name] });
    return jsonResult(analyzeLayer(getLayerSnapshot(snapshot, args.layer_name), await loadProjectProfile(snapshot.project), args.region));
  }));

  const legacyCommon = { project_path: projectPathField, scene_path: scenePathField, layer_name: layerField };
  server.registerTool("set_tiles", {
    title: "Set tiles (safe v1 adapter)",
    description: "v1-compatible tile placement. Creates a visual transaction preview by default; direct writes require --legacy-direct-writes.",
    inputSchema: z.object({ ...legacyCommon, tiles: z.array(legacyTileSchema).min(1) }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, {
    scenePath: args.scene_path,
    ...(args.project_path === undefined ? {} : { projectPath: args.project_path }),
    operations: [{ op: "set", layer: args.layer_name, cells: args.tiles.map((tile) => ({ x: tile.x, y: tile.y, tile: legacyRef(tile) })) }],
  }, options.legacyDirectWrites ?? false)));

  const singleTileFields = {
    source_id: z.number().int().min(0).max(65535),
    atlas_x: z.number().int().min(0).max(65535),
    atlas_y: z.number().int().min(0).max(65535),
    alt: z.number().int().min(0).max(65535).default(0),
  };
  server.registerTool("fill_rect", {
    title: "Fill rectangle (safe v1 adapter)",
    description: "v1-compatible rectangle fill routed through preview/apply transactions.",
    inputSchema: z.object({ ...legacyCommon, ...regionSchema.shape, ...singleTileFields }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, { scenePath: args.scene_path, ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), operations: [{ op: "fill", layer: args.layer_name, shape: { kind: "rect", x: args.x, y: args.y, width: args.width, height: args.height }, tile: legacyRef(args) }] }, options.legacyDirectWrites ?? false)));

  server.registerTool("paint_path", {
    title: "Paint path (safe v1 adapter)",
    description: "v1-compatible deterministic path routed through preview/apply transactions.",
    inputSchema: z.object({ ...legacyCommon, points: z.array(z.object({ x: z.number().int(), y: z.number().int() })).min(2), width: z.number().int().positive().default(1), jitter: z.number().min(0).default(0), seed: z.string().optional(), ...singleTileFields }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, { scenePath: args.scene_path, ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), ...(args.seed === undefined ? {} : { seed: args.seed }), operations: [{ op: "path", layer: args.layer_name, points: args.points, width: args.width, jitter: args.jitter, tile: legacyRef(args) }] }, options.legacyDirectWrites ?? false)));

  server.registerTool("stamp_pattern", {
    title: "Stamp pattern (safe v1 adapter)",
    description: "v1-compatible ASCII stamp routed through preview/apply transactions.",
    inputSchema: z.object({ ...legacyCommon, x: z.number().int(), y: z.number().int(), pattern: z.array(z.string()).min(1), palette: z.record(z.string(), z.object({ source_id: z.number().int().min(0).default(0), atlas_x: z.number().int().min(0), atlas_y: z.number().int().min(0), alt: z.number().int().min(0).default(0) })) }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, { scenePath: args.scene_path, ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), operations: [{ op: "stamp", layer: args.layer_name, origin: { x: args.x, y: args.y }, pattern: args.pattern, palette: Object.fromEntries(Object.entries(args.palette).map(([symbol, tile]) => [symbol, legacyRef(tile)])) }] }, options.legacyDirectWrites ?? false)));

  server.registerTool("erase_tiles", {
    title: "Erase tiles (safe v1 adapter)",
    description: "v1-compatible cell erasure routed through preview/apply transactions.",
    inputSchema: z.object({ ...legacyCommon, positions: z.array(z.object({ x: z.number().int(), y: z.number().int() })).min(1) }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, { scenePath: args.scene_path, ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), operations: [{ op: "erase", layer: args.layer_name, shape: { kind: "cells", cells: args.positions } }] }, options.legacyDirectWrites ?? false)));

  server.registerTool("erase_rect", {
    title: "Erase rectangle (safe v1 adapter)",
    description: "v1-compatible rectangle erasure routed through preview/apply transactions.",
    inputSchema: z.object({ ...legacyCommon, ...regionSchema.shape }),
    annotations: options.legacyDirectWrites ? sceneWrite : previewWrite,
  }, (args) => safe(() => legacyWrite(transactions, { scenePath: args.scene_path, ...(args.project_path === undefined ? {} : { projectPath: args.project_path }), operations: [{ op: "erase", layer: args.layer_name, shape: { kind: "rect", x: args.x, y: args.y, width: args.width, height: args.height } }] }, options.legacyDirectWrites ?? false)));

  return server;
}

export async function startTilemapMcpServer(options: TilemapMcpOptions): Promise<void> {
  const server = await createTilemapMcpServer(options);
  await server.connect(new StdioServerTransport());
}

const isEntryPoint = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  const projectPath = process.env.GODOT_PROJECT_PATH ?? process.cwd();
  startTilemapMcpServer({ projectPath }).catch((error: unknown) => {
    process.stderr.write(`godot-tilemap-mcp: ${errorMessage(error)}\n`);
    process.exitCode = 1;
  });
}
