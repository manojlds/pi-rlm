---
name: web-data-extraction
description: Extract structured data from websites using RLM recursive decomposition and browser tools. Use when you need to scrape, parse, or collect data from one or more web pages.
---

# Web Data Extraction with RLM

This skill uses the `rlm` tool to decompose web data extraction tasks into parallel subtasks — each targeting a specific page or section — then synthesizes the results into a single structured output.

## Prerequisites

The [browser-tools](https://github.com/badlogic/pi-skills) skill must be installed:

```bash
pi install-skill https://github.com/badlogic/pi-skills/tree/main/browser-tools
```

And [pi-rlm](https://github.com/manojlds/pi-rlm) must be installed:

```bash
pi install npm:pi-rlm
```

## How It Works

1. You describe what data to extract and from which URL(s)
2. The RLM planner decomposes the task (e.g., one subtask per page section, per URL, or per data category)
3. Each solver node uses `browser-content.js` or `browser-eval.js` to extract its piece
4. The synthesizer merges all extracted data into the requested format (JSON, markdown table, CSV, etc.)

## Usage

### Single page extraction

Extract structured data from a single page by decomposing across data sections:

```
Use the rlm tool to extract all product information from https://books.toscrape.com/.
For each book, extract: title, price, rating, and availability.
Return the results as a JSON array.

Use browser-content.js for page extraction and browser-eval.js for targeted DOM queries.
Start the browser first with browser-start.js if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=12, toolsProfile=coding
```

### Multi-page extraction

Extract data across multiple pages in parallel:

```
Use the rlm tool to extract conference talk information from these pages:
- https://example.com/talks/day1
- https://example.com/talks/day2
- https://example.com/talks/day3

For each talk extract: title, speaker, time slot, room, and abstract.
Decompose by page so each page is scraped in parallel.
Return a unified JSON array sorted by time slot.

Use browser-content.js for full page extraction.
Start the browser first with browser-start.js if not already running.

RLM settings: backend=sdk, mode=decompose, maxDepth=1, maxNodes=8, toolsProfile=coding
```

### Paginated extraction

Handle paginated listings:

```
Use the rlm tool to extract all job listings from https://example.com/careers.
The page is paginated — extract from the first 5 pages.
For each listing extract: title, department, location, and posting date.
Return as a JSON array.

Use browser-eval.js to navigate pagination and extract listings.
Start the browser first with browser-start.js if not already running.

RLM settings: backend=sdk, mode=auto, maxDepth=2, maxNodes=16, toolsProfile=coding
```

## Important Notes

- **RLM subtask nodes run with `--no-skills`**, so browser tool instructions must be part of the task description. The RLM solver nodes have access to `bash` and can run `browser-*.js` scripts directly.
- **Start the browser before the RLM run.** Run `browser-start.js` (or `browser-start.js --profile` for authenticated sessions) before invoking the rlm tool.
- **Use `browser-content.js`** for full-page markdown extraction — it handles JavaScript-rendered pages.
- **Use `browser-eval.js`** for targeted DOM queries when you need specific elements.
- **Prefer `mode=decompose` with `maxDepth=1`** for multi-URL tasks — one subtask per URL gives clean parallel extraction.
- **Use `mode=auto`** for single-page tasks where the planner can decide whether to decompose by section.

## Recommended RLM Settings

| Scenario | mode | maxDepth | maxNodes | concurrency |
|---|---|---|---|---|
| Single page, simple structure | solve | 0 | 1 | 1 |
| Single page, complex sections | auto | 2 | 12 | 2 |
| Multi-page (2-5 URLs) | decompose | 1 | 8 | 3 |
| Multi-page (5-20 URLs) | decompose | 1 | 24 | 3 |
| Paginated listing | auto | 2 | 16 | 2 |
