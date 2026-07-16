import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { EditOperation, TileCell } from "./types.js";
import type { TerrainBridge } from "./edit.js";

interface BridgeResponse {
  ok: boolean;
  error?: string;
  cells?: Array<{
    x: number;
    y: number;
    source_id: number;
    atlas_x: number;
    atlas_y: number;
    alternative_id: number;
  }>;
  positions?: Array<{ x: number; y: number; local_x: number; local_y: number }>;
}

async function isExecutable(candidate: string): Promise<boolean> {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function commandOnPath(command: string): Promise<string | null> {
  const paths = (process.env.PATH ?? "").split(path.delimiter);
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of paths) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (await isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

export async function detectGodotExecutable(explicitPath?: string): Promise<string | null> {
  const configured = explicitPath ?? process.env.GODOT_PATH;
  if (configured) return await isExecutable(configured) ? configured : null;
  for (const command of ["godot4", "godot", "godot4-mono"]) {
    const found = await commandOnPath(command);
    if (found) return found;
  }
  if (process.platform === "darwin") {
    const macPath = "/Applications/Godot.app/Contents/MacOS/Godot";
    if (await isExecutable(macPath)) return macPath;
  }
  return null;
}

function bridgeScriptPath(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDirectory, "../bridge/godot_tilemap_bridge.gd");
}

export class GodotBridge implements TerrainBridge {
  readonly executable: string;

  constructor(executable: string) {
    this.executable = executable;
  }

  private async request(projectPath: string, payload: Record<string, unknown>): Promise<BridgeResponse> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "godot-tilemap-mcp-bridge-"));
    const requestPath = path.join(directory, "request.json");
    const responsePath = path.join(directory, "response.json");
    await writeFile(requestPath, JSON.stringify(payload), "utf8");
    try {
      const args = [
        "--headless",
        "--quiet",
        "--no-header",
        "--recovery-mode",
        "--path",
        projectPath,
        "--script",
        bridgeScriptPath(),
        "--",
        "--request",
        requestPath,
        "--response",
        responsePath,
      ];
      await new Promise<void>((resolve, reject) => {
        const child = spawn(this.executable, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
        child.on("error", reject);
        child.on("exit", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Godot bridge exited with code ${code}: ${stderr.trim()}`));
        });
      });
      const response = JSON.parse(await readFile(responsePath, "utf8")) as BridgeResponse;
      if (!response.ok) throw new Error(response.error ?? "Godot bridge returned an unknown error");
      return response;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  async applyTerrain(input: {
    projectPath: string;
    scenePath: string;
    layerPath: string;
    tileMapDataBase64: string;
    operation: Extract<EditOperation, { op: "terrain_connect" | "terrain_path" }>;
  }): Promise<TileCell[]> {
    const sceneResourcePath = input.scenePath.startsWith("res://")
      ? input.scenePath
      : `res://${path.relative(input.projectPath, input.scenePath).split(path.sep).join("/")}`;
    if (sceneResourcePath.startsWith("res://../")) throw new Error("Terrain bridge scene is outside its project root");
    const response = await this.request(input.projectPath, {
      action: "apply_terrain",
      scene_path: sceneResourcePath,
      layer_path: input.layerPath,
      tile_map_data: input.tileMapDataBase64,
      operation: input.operation.op,
      points: input.operation.op === "terrain_connect" ? input.operation.cells : input.operation.points,
      terrain_set: input.operation.terrainSet,
      terrain: input.operation.terrain,
      ignore_empty_terrains: input.operation.ignoreEmptyTerrains ?? true,
    });
    return (response.cells ?? []).map((cell) => ({
      x: cell.x,
      y: cell.y,
      sourceId: cell.source_id,
      atlasX: cell.atlas_x,
      atlasY: cell.atlas_y,
      alternativeId: cell.alternative_id,
    }));
  }

  async mapPositions(projectPath: string, scenePath: string, layerPath: string, points: Array<{ x: number; y: number }>): Promise<Array<{ x: number; y: number; localX: number; localY: number }>> {
    const sceneResourcePath = scenePath.startsWith("res://")
      ? scenePath
      : `res://${path.relative(projectPath, scenePath).split(path.sep).join("/")}`;
    if (sceneResourcePath.startsWith("res://../")) throw new Error("Godot bridge scene is outside its project root");
    const response = await this.request(projectPath, {
      action: "map_positions",
      scene_path: sceneResourcePath,
      layer_path: layerPath,
      points,
    });
    return (response.positions ?? []).map((position) => ({
      x: position.x,
      y: position.y,
      localX: position.local_x,
      localY: position.local_y,
    }));
  }
}
