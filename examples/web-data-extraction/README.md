# Web Data Extraction Example (Self-Contained)

This example is an **isolated mini-project** with its own:

- `.pi/settings.json` (project-local pi package config)
- `package.json` and setup scripts
- local browser-tools runtime inside this example's `.pi/` directory

It is designed so you can run and experiment without changing the main repo's `.pi` setup.

## Project Layout

```text
examples/web-data-extraction/
  .pi/settings.json
  SKILL.md
  package.json
  scripts/
    setup.mjs
    resolve-browser-tools.sh
    browser-start.sh
    browser-nav.sh
    browser-content.sh
    browser-eval.sh
```

## Setup

From repo root:

```bash
cd examples/web-data-extraction
npm run setup
```

`npm run setup` will:

1. Ensure project-local `npm:pi-rlm` is installed (inside this example's `.pi` scope)
2. Download `browser-tools` into `.pi/skills/browser-tools`
3. Install npm dependencies for that local browser-tools runtime

### Start Chrome for browser-tools

```bash
./scripts/browser-start.sh
# or with your profile/cookies:
./scripts/browser-start.sh --profile
```

## Quick Start (Pi Agent)

From `examples/web-data-extraction/`:

```text
Use the web-data-extraction skill to extract all book titles, prices, and ratings from https://books.toscrape.com/ and return JSON.
```

## Why wrappers are used

RLM subtask nodes run with `--no-skills`, so they cannot rely on skill placeholders like `{baseDir}`.

This example uses local wrappers (`./scripts/browser-*.sh`) so solver nodes can run browser tools reliably from the same working directory.

## Example prompt templates

### Single page extraction

```text
Use the rlm tool to extract all product information from https://books.toscrape.com/.
For each book, extract: title, price, rating, and availability.
Return the results as a JSON array.

Use ./scripts/browser-content.sh for full page extraction and ./scripts/browser-eval.sh for targeted DOM queries.
Start the browser first with ./scripts/browser-start.sh if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=12, toolsProfile=coding
```

### Multi-page extraction (parallel)

```text
Use the rlm tool to extract conference talk information from these pages:
- https://example.com/talks/day1
- https://example.com/talks/day2
- https://example.com/talks/day3

For each talk extract: title, speaker, time slot, room, and abstract.
Decompose by page so each page is scraped in parallel.
Return a unified JSON array sorted by time slot.

Use ./scripts/browser-content.sh for full page extraction.
Start the browser first with ./scripts/browser-start.sh if not already running.

RLM settings: backend=sdk, mode=decompose, maxDepth=1, maxNodes=8, toolsProfile=coding
```

### Paginated extraction

```text
Use the rlm tool to extract all job listings from https://example.com/careers.
The page is paginated — extract from the first 5 pages.
For each listing extract: title, department, location, and posting date.
Return as a JSON array.

Use ./scripts/browser-nav.sh and ./scripts/browser-eval.sh to navigate pagination and extract listings.
Start the browser first with ./scripts/browser-start.sh if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=16, toolsProfile=coding
```
