import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRECTORIES = new Set([".git", ".godot", "node_modules", "dist", "build", "bin", "obj"]);

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function findProjectRoot(startPath: string): Promise<string> {
  let cursor = path.resolve(startPath);
  try {
    if (!(await stat(cursor)).isDirectory()) cursor = path.dirname(cursor);
  } catch {
    cursor = path.dirname(cursor);
  }
  while (true) {
    if (await exists(path.join(cursor, "project.godot"))) return await realpath(cursor);
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  throw new Error(`No project.godot found above ${startPath}`);
}

export class ProjectPaths {
  readonly defaultProject: string;
  readonly allowedRoots: string[];

  private constructor(defaultProject: string, allowedRoots: string[]) {
    this.defaultProject = defaultProject;
    this.allowedRoots = allowedRoots;
  }

  static async create(defaultProject: string, allowedRoots: string[] = []): Promise<ProjectPaths> {
    const project = await findProjectRoot(defaultProject);
    const roots = new Set<string>([project]);
    for (const root of allowedRoots) {
      roots.add(await realpath(path.resolve(root)));
    }
    return new ProjectPaths(project, [...roots]);
  }

  async resolveProject(projectPath?: string): Promise<string> {
    const project = projectPath ? await findProjectRoot(projectPath) : this.defaultProject;
    if (!this.allowedRoots.some((root) => isWithin(root, project))) {
      throw new Error(`Project ${project} is outside the configured allowed roots`);
    }
    return project;
  }

  async resolveFile(input: string, projectPath?: string): Promise<{ project: string; file: string }> {
    const hintedProject = projectPath ? await this.resolveProject(projectPath) : this.defaultProject;
    let candidate: string;
    if (input.startsWith("res://")) candidate = path.join(hintedProject, input.slice(6));
    else if (path.isAbsolute(input)) candidate = input;
    else candidate = path.join(hintedProject, input);

    const canonical = await realpath(path.resolve(candidate));
    const owningProject = await findProjectRoot(canonical);
    await this.resolveProject(owningProject);
    if (!isWithin(owningProject, canonical)) throw new Error(`Path ${input} escapes its Godot project`);
    return { project: owningProject, file: canonical };
  }

  toResourcePath(project: string, file: string): string {
    return `res://${path.relative(project, file).split(path.sep).join("/")}`;
  }

  resolveResourcePath(project: string, resourcePath: string): string {
    if (resourcePath.startsWith("res://")) return path.join(project, resourcePath.slice(6));
    if (path.isAbsolute(resourcePath)) return resourcePath;
    return path.join(project, resourcePath);
  }
}

export function shouldIgnoreDirectory(name: string): boolean {
  return name.startsWith(".") || IGNORED_DIRECTORIES.has(name);
}
