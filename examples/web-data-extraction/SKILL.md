---
name: web-data-extraction
description: Extract structured data from websites using RLM decomposition and browser tools from this example's self-contained project setup.
---

# Web Data Extraction with RLM (Self-Contained Example)

Use this skill from `examples/web-data-extraction/`.

This example is isolated with its own `.pi/settings.json`, local package setup, and wrapper scripts so it does not interfere with other projects.

## Setup (run once)

```bash
npm run setup
```

This installs `npm:pi-rlm` for this example scope and prepares local browser-tools dependencies under `.pi/`.

Then start Chrome for browser automation:

```bash
./scripts/browser-start.sh
# or with existing profile/cookies
./scripts/browser-start.sh --profile
```

## Important Runtime Rule

RLM subtask nodes run with `--no-skills`.

So task instructions must tell solver nodes to use local wrappers (not bare `browser-content.js`):

- `./scripts/browser-content.sh`
- `./scripts/browser-eval.sh`
- `./scripts/browser-nav.sh`

## Usage

### Single page extraction

```text
Use the rlm tool to extract all product information from https://books.toscrape.com/.
For each book, extract: title, price, rating, and availability.
Return the results as a JSON array.

Use ./scripts/browser-content.sh for page extraction and ./scripts/browser-eval.sh for targeted DOM queries.
Start the browser first with ./scripts/browser-start.sh if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=12, toolsProfile=coding
```

### Multi-page extraction

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

Use ./scripts/browser-nav.sh and ./scripts/browser-eval.sh to navigate pages and extract listings.
Start the browser first with ./scripts/browser-start.sh if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=16, toolsProfile=coding
```
