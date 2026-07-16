import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { GodotBridge, detectGodotExecutable } from "./bridge.js";
import { planEdit, type TerrainBridge } from "./edit.js";
import { findTileMapLayers, parseGodotText, patchTileMapData, resolveLayer } from "./godotText.js";
import type { ProjectPaths } from "./paths.js";
import { loadProjectProfile } from "./profile.js";
import { loadSceneSnapshot, revisionForText } from "./project.js";
import { writeEditPreview } from "./render.js";
import type { EditRecipe, EditTransaction, LayerEditResult } from "./types.js";

export interface TransactionStoreOptions {
  cacheRoot?: string;
  ttlHours?: number;
  godotPath?: string;
  bridge?: TerrainBridge | null;
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

function assertTransactionId(id: string): void {
  if (!/^tx_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)) {
    throw new Error(`Invalid tilemap transaction id "${id}"`);
  }
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const metadata = await stat(filePath);
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.godot-tilemap-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", metadata.mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporary, metadata.mode);
    await rename(temporary, filePath);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function patchScene(text: string, layers: LayerEditResult[], useOriginal: boolean): string {
  const document = parseGodotText(text);
  const descriptors = findTileMapLayers(document);
  return patchTileMapData(document, layers.map((layer) => ({
    layer: resolveLayer(descriptors, layer.layer),
    ...(useOriginal ? { rawLine: layer.originalPropertyLine } : { base64: layer.nextBase64 }),
  })));
}

async function withExclusiveLock<T>(lockPath: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(lockPath), { recursive: true });
  let handle;
  try {
    handle = await open(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(`Another tilemap transaction currently owns ${lockPath}`);
    }
    throw error;
  }
  try {
    await handle.writeFile(`${process.pid}\n`, "utf8");
    return await action();
  } finally {
    await handle.close();
    await rm(lockPath, { force: true });
  }
}

export class TransactionStore {
  readonly paths: ProjectPaths;
  readonly cacheRoot: string;
  readonly ttlHours: number;
  private readonly explicitBridge: TerrainBridge | null | undefined;
  private readonly godotPath: string | undefined;

  constructor(paths: ProjectPaths, options: TransactionStoreOptions = {}) {
    this.paths = paths;
    this.cacheRoot = options.cacheRoot
      ?? path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "godot-tilemap-mcp");
    this.ttlHours = options.ttlHours ?? 24;
    this.explicitBridge = options.bridge;
    this.godotPath = options.godotPath;
  }

  private projectDirectory(project: string): string {
    return path.join(this.cacheRoot, "projects", stableHash(project));
  }

  private transactionDirectory(project: string, id: string): string {
    return path.join(this.projectDirectory(project), "transactions", id);
  }

  private transactionPath(project: string, id: string): string {
    return path.join(this.transactionDirectory(project, id), "transaction.json");
  }

  private async save(transaction: EditTransaction): Promise<void> {
    const filePath = this.transactionPath(transaction.projectPath, transaction.id);
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(transaction, null, 2)}\n`, "utf8");
  }

  private async terrainBridge(recipe: EditRecipe): Promise<TerrainBridge | null> {
    const needsBridge = recipe.operations.some((operation) => operation.op === "terrain_connect" || operation.op === "terrain_path");
    if (!needsBridge) return null;
    if (this.explicitBridge !== undefined) return this.explicitBridge;
    const executable = await detectGodotExecutable(this.godotPath);
    if (!executable) throw new Error("Terrain operations require a Godot executable; pass --godot or set GODOT_PATH");
    return new GodotBridge(executable);
  }

  async preview(recipe: EditRecipe): Promise<EditTransaction> {
    if (recipe.operations.length === 0) throw new Error("An edit recipe must contain at least one operation");
    const requestedLayers = [...new Set(recipe.operations.map((operation) => operation.layer))];
    const snapshot = await loadSceneSnapshot(this.paths, recipe.scenePath, {
      ...(recipe.projectPath === undefined ? {} : { projectPath: recipe.projectPath }),
      layers: requestedLayers,
      includeTileSets: true,
    });
    if (recipe.expectedRevision && recipe.expectedRevision !== snapshot.revision) {
      throw new Error(`Scene revision mismatch: expected ${recipe.expectedRevision}, found ${snapshot.revision}`);
    }
    const profile = await loadProjectProfile(snapshot.project);
    const planned = await planEdit(snapshot, recipe, profile, await this.terrainBridge(recipe));
    const id = `tx_${randomUUID()}`;
    const createdAt = new Date();
    const transaction: EditTransaction = {
      id,
      projectPath: snapshot.project,
      scenePath: snapshot.scenePath,
      baseRevision: snapshot.revision,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + this.ttlHours * 60 * 60 * 1_000).toISOString(),
      recipe: { ...recipe, scenePath: snapshot.resourcePath, projectPath: snapshot.project },
      layers: planned.layers,
      warnings: planned.warnings,
    };
    if (planned.layers.length > 0) {
      const preview = await writeEditPreview(
        snapshot,
        planned.layers,
        path.join(this.transactionDirectory(snapshot.project, id), "preview"),
        profile?.raw.limits.max_render_pixels,
      );
      transaction.preview = preview;
    }
    await this.save(transaction);
    return transaction;
  }

  async read(id: string, projectPath?: string): Promise<EditTransaction> {
    assertTransactionId(id);
    const project = await this.paths.resolveProject(projectPath);
    const filePath = this.transactionPath(project, id);
    try {
      return JSON.parse(await readFile(filePath, "utf8")) as EditTransaction;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`Tilemap transaction ${id} was not found for ${project}`);
      throw error;
    }
  }

  async apply(id: string, projectPath?: string): Promise<EditTransaction> {
    const transaction = await this.read(id, projectPath);
    if (transaction.appliedRevision && !transaction.undoneAt) throw new Error(`Transaction ${id} has already been applied`);
    if (Date.parse(transaction.expiresAt) < Date.now()) throw new Error(`Transaction ${id} expired at ${transaction.expiresAt}; create a fresh preview`);
    const lock = path.join(this.projectDirectory(transaction.projectPath), "locks", `${stableHash(transaction.scenePath)}.lock`);
    return withExclusiveLock(lock, async () => {
      const currentText = await readFile(transaction.scenePath, "utf8");
      const currentRevision = revisionForText(currentText);
      if (currentRevision !== transaction.baseRevision) {
        throw new Error(`Scene changed after preview: expected ${transaction.baseRevision}, found ${currentRevision}. No files were written.`);
      }
      const nextText = patchScene(currentText, transaction.layers, false);
      await atomicWrite(transaction.scenePath, nextText);
      transaction.appliedRevision = revisionForText(nextText);
      transaction.appliedAt = new Date().toISOString();
      delete transaction.undoneRevision;
      delete transaction.undoneAt;
      await this.save(transaction);
      return transaction;
    });
  }

  async undo(id: string, projectPath?: string): Promise<EditTransaction> {
    const transaction = await this.read(id, projectPath);
    if (!transaction.appliedRevision || !transaction.appliedAt) throw new Error(`Transaction ${id} has not been applied`);
    if (transaction.undoneAt) throw new Error(`Transaction ${id} has already been undone`);
    const lock = path.join(this.projectDirectory(transaction.projectPath), "locks", `${stableHash(transaction.scenePath)}.lock`);
    return withExclusiveLock(lock, async () => {
      const currentText = await readFile(transaction.scenePath, "utf8");
      const currentRevision = revisionForText(currentText);
      if (currentRevision !== transaction.appliedRevision) {
        throw new Error(`Scene changed after apply: expected ${transaction.appliedRevision}, found ${currentRevision}. Undo was not written.`);
      }
      const restoredText = patchScene(currentText, transaction.layers, true);
      await atomicWrite(transaction.scenePath, restoredText);
      transaction.undoneRevision = revisionForText(restoredText);
      transaction.undoneAt = new Date().toISOString();
      await this.save(transaction);
      return transaction;
    });
  }

  async discard(id: string, projectPath?: string): Promise<void> {
    const transaction = await this.read(id, projectPath);
    if (transaction.appliedAt && !transaction.undoneAt) {
      throw new Error(`Transaction ${id} is applied; undo it before discarding its recovery data`);
    }
    await rm(this.transactionDirectory(transaction.projectPath, transaction.id), { recursive: true, force: true });
  }

  async list(projectPath?: string): Promise<EditTransaction[]> {
    const project = await this.paths.resolveProject(projectPath);
    const directory = path.join(this.projectDirectory(project), "transactions");
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const transactions: EditTransaction[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        transactions.push(await this.read(entry.name, project));
      } catch {
        // Ignore interrupted or manually removed cache entries.
      }
    }
    return transactions.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }
}
