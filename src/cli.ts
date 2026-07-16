#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ProjectPaths,
  TransactionStore,
  analyzeLayer,
  detectGodotExecutable,
  findCatalogTiles,
  getLayerSnapshot,
  inspectTileSet,
  listTilemapScenes,
  loadProjectProfile,
  loadSceneSnapshot,
  parseEditRecipe,
  renderCatalogImage,
  renderSceneImage,
  writeDefaultProjectProfile,
  type EditTransaction,
  type Region,
} from "./core/index.js";
import { startTilemapMcpServer } from "./mcp/server.js";

interface ParsedArguments {
  values: string[];
  options: Map<string, string[]>;
}

function parseArguments(input: string[]): ParsedArguments {
  const values: string[] = [];
  const options = new Map<string, string[]>();
  for (let index = 0; index < input.length; index++) {
    const token = input[index]!;
    if (!token.startsWith("--")) {
      values.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    const name = equals >= 0 ? token.slice(2, equals) : token.slice(2);
    const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
    const next = input[index + 1];
    const value = inline ?? (next && !next.startsWith("--") ? (index++, next) : "true");
    const entries = options.get(name) ?? [];
    entries.push(value);
    options.set(name, entries);
  }
  return { values, options };
}

function option(args: ParsedArguments, name: string, fallback?: string): string | undefined {
  return args.options.get(name)?.at(-1) ?? fallback;
}

function flag(args: ParsedArguments, name: string): boolean {
  const value = option(args, name);
  return value === "true" || value === "1" || value === "yes";
}

function requireValue(value: string | undefined, label: string): string {
  if (!value) throw new Error(`Missing ${label}`);
  return value;
}

function parseRegion(raw: string | undefined): Region | undefined {
  if (!raw) return undefined;
  const values = raw.split(",").map(Number);
  if (values.length !== 4 || values.some((value) => !Number.isInteger(value))) throw new Error("--region must be x,y,width,height using integers");
  const [x, y, width, height] = values as [number, number, number, number];
  if (width <= 0 || height <= 0) throw new Error("--region width and height must be positive");
  return { x, y, width, height };
}

function transactionSummary(transaction: EditTransaction): Record<string, unknown> {
  return {
    id: transaction.id,
    project_path: transaction.projectPath,
    scene_path: transaction.scenePath,
    base_revision: transaction.baseRevision,
    created_at: transaction.createdAt,
    expires_at: transaction.expiresAt,
    changed_cells: transaction.layers.reduce((sum, layer) => sum + layer.changes.length, 0),
    layers: transaction.layers.map((layer) => ({ layer: layer.layer, changes: layer.changes.length, bounds: layer.bounds })),
    warnings: transaction.warnings,
    preview: transaction.preview ?? null,
    applied_revision: transaction.appliedRevision ?? null,
    applied_at: transaction.appliedAt ?? null,
    undone_at: transaction.undoneAt ?? null,
  };
}

function print(value: unknown): void {
  process.stdout.write(`${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`);
}

function help(): string {
  return `godot-tilemap-mcp 2.0 — visual, semantic and transactional Godot 4 tilemap tooling

Usage:
  godot-tilemap-mcp <command> [arguments] [options]

Commands:
  mcp                         Start the stdio MCP server
  doctor                      Diagnose project, profile and Godot bridge
  list                        List scenes with TileMapLayer nodes
  inspect <scene>             Inspect layers, bounds and TileSet summaries
  catalog <tileset.tres>      Inspect/search a TileSet catalog
  render <scene> --out <png>  Render real atlas tiles to PNG
  analyze <scene> --layer <n> Analyze repetition, topology and references
  plan <recipe.json>          Create revision-locked preview transaction
  apply <transaction-id>      Atomically apply a preview
  undo <transaction-id>       Undo if the scene has not changed
  discard <transaction-id>    Remove cached transaction artifacts
  transactions                List cached transactions
  config init                 Create .godot-tilemap-mcp.json

Global options:
  --project <path>            Godot project root (default: GODOT_PROJECT_PATH or cwd)
  --allow-root <path>         Additional allowed root; may be repeated (useful for worktrees)
  --godot <path>              Godot executable for terrain operations
  --legacy-direct-writes      Let v1 MCP write tools apply immediately (unsafe compatibility mode)

Render options: --layer <path> (repeatable), --region x,y,w,h, --scale N, --grid, --background checker|transparent|#RRGGBB
Catalog filters: --text <query>, --terrain-set N, --terrain N, --physics, --navigation, --out <contact-sheet.png>`;
}

async function run(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  const command = args.values[0] ?? "help";
  if (command === "version" || flag(args, "version")) {
    print("2.0.0");
    return;
  }
  if (command === "help" || command === "--help" || flag(args, "help")) {
    print(help());
    return;
  }
  const projectPath = option(args, "project", process.env.GODOT_PROJECT_PATH ?? process.cwd())!;
  const allowedRoots = args.options.get("allow-root") ?? [];
  const godotPath = option(args, "godot");
  if (command === "mcp") {
    await startTilemapMcpServer({
      projectPath,
      allowedRoots,
      legacyDirectWrites: flag(args, "legacy-direct-writes"),
      ...(godotPath === undefined ? {} : { godotPath }),
    });
    return;
  }

  const paths = await ProjectPaths.create(projectPath, allowedRoots);
  const transactions = new TransactionStore(paths, { ...(godotPath === undefined ? {} : { godotPath }) });
  if (command === "doctor") {
    const project = await paths.resolveProject(projectPath);
    const [profile, godot, scenes] = await Promise.all([
      loadProjectProfile(project),
      detectGodotExecutable(godotPath),
      listTilemapScenes(paths, project),
    ]);
    print({
      ok: true,
      project,
      godot_bridge: godot,
      profile: profile ? path.join(project, ".godot-tilemap-mcp.json") : null,
      scenes: scenes.length,
      layers: scenes.reduce((sum, scene) => sum + scene.layers.length, 0),
    });
    return;
  }
  if (command === "list") {
    print(await listTilemapScenes(paths, projectPath));
    return;
  }
  if (command === "inspect") {
    const scene = requireValue(args.values[1], "scene path");
    const layer = option(args, "layer");
    const snapshot = await loadSceneSnapshot(paths, scene, { projectPath, ...(layer === undefined ? {} : { layers: [layer] }) });
    print({
      scene: snapshot.resourcePath,
      revision: snapshot.revision,
      layers: snapshot.layers.map((entry) => ({
        path: entry.descriptor.fullPath,
        tile_count: entry.cells.length,
        bounds: entry.bounds,
        tileset: entry.tileSet ? {
          resource: entry.tileSet.resourceKey,
          tile_size: entry.tileSet.tileSize,
          sources: entry.tileSet.sources.length,
          tiles: entry.tileSet.tiles.length,
          custom_data_layers: entry.tileSet.customDataLayers,
          terrains: entry.tileSet.terrains,
          warnings: entry.tileSet.warnings,
        } : null,
      })),
    });
    return;
  }
  if (command === "catalog") {
    const tileSetInput = requireValue(args.values[1], "TileSet path");
    const resolved = await paths.resolveFile(tileSetInput, projectPath);
    const catalog = await inspectTileSet(resolved.file, { resourceKey: paths.toResourcePath(resolved.project, resolved.file) });
    const matches = findCatalogTiles(catalog, {
      ...(option(args, "text") === undefined ? {} : { text: option(args, "text")! }),
      ...(option(args, "terrain-set") === undefined ? {} : { terrainSet: Number(option(args, "terrain-set")) }),
      ...(option(args, "terrain") === undefined ? {} : { terrain: Number(option(args, "terrain")) }),
      ...(flag(args, "physics") ? { hasPhysics: true } : {}),
      ...(flag(args, "navigation") ? { hasNavigation: true } : {}),
      limit: Number(option(args, "limit", "256")),
    });
    const output = option(args, "out");
    if (output) await writeFile(path.resolve(output), await renderCatalogImage(resolved.project, catalog, matches));
    print({ resource: catalog.resourceKey, tile_size: catalog.tileSize, custom_data_layers: catalog.customDataLayers, terrains: catalog.terrains, sources: catalog.sources, count: matches.length, tiles: matches, contact_sheet: output ? path.resolve(output) : null, warnings: catalog.warnings });
    return;
  }
  if (command === "render") {
    const scene = requireValue(args.values[1], "scene path");
    const output = path.resolve(requireValue(option(args, "out"), "--out <png>"));
    const layers = args.options.get("layer");
    const snapshot = await loadSceneSnapshot(paths, scene, { projectPath, ...(layers === undefined ? {} : { layers }) });
    const profile = await loadProjectProfile(snapshot.project);
    const rendered = await renderSceneImage(snapshot, {
      ...(layers === undefined ? {} : { layers }),
      ...(parseRegion(option(args, "region")) === undefined ? {} : { region: parseRegion(option(args, "region"))! }),
      scale: Number(option(args, "scale", "1")),
      background: option(args, "background", "checker")!,
      grid: flag(args, "grid"),
      maxPixels: profile?.raw.limits.max_render_pixels ?? 16_777_216,
    });
    await writeFile(output, rendered.png);
    print({ output, bounds: rendered.bounds, pixels: { width: rendered.pixelWidth, height: rendered.pixelHeight }, warnings: rendered.warnings });
    return;
  }
  if (command === "analyze") {
    const scene = requireValue(args.values[1], "scene path");
    const layerName = requireValue(option(args, "layer"), "--layer <path>");
    const snapshot = await loadSceneSnapshot(paths, scene, { projectPath, layers: [layerName] });
    print(analyzeLayer(getLayerSnapshot(snapshot, layerName), await loadProjectProfile(snapshot.project), parseRegion(option(args, "region"))));
    return;
  }
  if (command === "plan" || command === "preview") {
    const recipePath = path.resolve(requireValue(args.values[1], "recipe JSON path"));
    const raw = JSON.parse(await readFile(recipePath, "utf8")) as Record<string, unknown>;
    if (raw.projectPath === undefined) raw.projectPath = projectPath;
    print(transactionSummary(await transactions.preview(parseEditRecipe(raw))));
    return;
  }
  if (command === "apply") {
    print(transactionSummary(await transactions.apply(requireValue(args.values[1], "transaction id"), projectPath)));
    return;
  }
  if (command === "undo") {
    print(transactionSummary(await transactions.undo(requireValue(args.values[1], "transaction id"), projectPath)));
    return;
  }
  if (command === "discard") {
    const id = requireValue(args.values[1], "transaction id");
    await transactions.discard(id, projectPath);
    print({ discarded: true, transaction_id: id });
    return;
  }
  if (command === "transactions") {
    print((await transactions.list(projectPath)).map(transactionSummary));
    return;
  }
  if (command === "config" && args.values[1] === "init") {
    print({ created: await writeDefaultProjectProfile(await paths.resolveProject(projectPath)) });
    return;
  }
  throw new Error(`Unknown command "${command}". Run godot-tilemap-mcp help.`);
}

run().catch((error: unknown) => {
  process.stderr.write(`godot-tilemap-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
