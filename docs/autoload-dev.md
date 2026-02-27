# Autoload Development Notes

This project is set up so pi can auto-discover the extension during local development.

## How it works

- File: `.pi/extensions/rlm/index.ts`
- It re-exports the extension entrypoint from `src/index.ts`.
- pi auto-loads project extensions from `.pi/extensions/*/index.ts`.

## Dev loop

1. Start `pi` in this repository root.
2. Edit files in `src/`.
3. In pi, run `/reload`.
4. Re-run your prompt/tool call.

## Alternative ways to load

- One-off testing:
  - `pi -e ./src/index.ts`
- Settings-based explicit path:
  - add to `.pi/settings.json`:
    - `"extensions": ["./src/index.ts"]`

Use one method at a time to avoid duplicate tool registration conflicts.

## Reference

Official pi docs: `docs/extensions.md` in the pi installation.
