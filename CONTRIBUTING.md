# Contributing

Thanks for helping make tilemap authoring more capable and safer.

## Development setup

```bash
npm install
npm run typecheck
npm run build
npm test
```

Use Node.js 22 or newer. Keep fixtures synthetic or redistributable; never add private game maps or third-party assets without a compatible license.

## Design principles

- Keep this a TileMap specialist rather than a general Godot automation server.
- Put reusable behavior in the typed core; MCP and CLI should remain adapters.
- Prefer static, lossless inspection. Use the Godot bridge only where engine semantics matter.
- Every scene mutation must participate in preview, revision validation, atomic apply, and guarded undo.
- Deterministic operations need stable seeds and ordered output.
- Unknown or unsupported content must be reported, not silently discarded.
- Preserve v1 tool compatibility when a safe adapter is possible.

## Pull requests

- Keep changes focused and document user-visible behavior.
- Add synthetic coverage for parsers, codecs, edits, and failure cases.
- Do not regenerate Godot scenes as generic text or JSON.
- Update `CHANGELOG.md` for meaningful changes.
- Explain compatibility and security implications in the pull request.

Contributions are accepted under the MIT license.
