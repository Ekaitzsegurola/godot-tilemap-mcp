# Security policy

## Supported version

Security fixes target the latest major release.

## Trust model

This tool is intended for a local stdio MCP connection. It can read Godot project files and, after an explicit transaction apply, modify `tile_map_data` in scenes. Treat access to the server as equivalent to local project-file access.

The runtime makes no cloud/API calls. Tile textures, scene data, profiles, recipes, and preview artifacts stay local. The optional bridge starts a local Godot executable in headless recovery mode and exchanges request/response JSON through a private temporary directory.

## Built-in controls

- Project and worktree roots are explicit and allow-listed.
- Canonical paths must remain inside an owning Godot project.
- Scene writes require a prior preview transaction and an exact SHA-256 revision match.
- Writes use per-scene locks, a sibling temporary file, synchronization, and atomic rename.
- Only `tile_map_data` properties are changed.
- Undo refuses to overwrite later work.
- Profiles can protect runtime or metadata layers and cap edit/render size.
- Legacy tools are preview-only unless direct mode is explicitly enabled at server startup.

Do not run with `--legacy-direct-writes` for untrusted clients. Do not allow broad filesystem roots that contain unrelated projects or secrets.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's security advisory flow for this repository. Include the affected version, platform, reproduction, impact, and any suggested mitigation. Avoid filing a public issue until a fix is available.
