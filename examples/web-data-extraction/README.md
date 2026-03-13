# Web Data Extraction Example

This example demonstrates using [pi-rlm](https://github.com/manojlds/pi-rlm) with the [browser-tools](https://github.com/badlogic/pi-skills) skill to extract structured data from websites.

RLM decomposes extraction tasks into parallel subtasks — each targeting a specific page or section — then synthesizes results into a unified output.

## Setup

1. Install pi-rlm and browser-tools:

```bash
pi install npm:pi-rlm
pi install-skill https://github.com/badlogic/pi-skills/tree/main/browser-tools
```

2. Install the example skill (from this repo):

```bash
pi install-skill ./examples/web-data-extraction
```

## Quick Start

### Using the pi agent

Start a pi session and ask it to extract data:

```
Extract all book titles, prices, and ratings from https://books.toscrape.com/ using the web-data-extraction skill.
```

Pi will load the skill, start the browser, and invoke the `rlm` tool to decompose and extract the data.

### Using the CLI

```bash
# Single page extraction
pi-rlm --task 'Extract all book data (title, price, rating, availability) from https://books.toscrape.com/ as JSON. Use browser-content.js to scrape the page. Start browser with browser-start.js first.' \
  --backend sdk --mode auto --max-depth 2 --max-nodes 12

# Multi-page extraction with parallel decomposition
pi-rlm --task 'Extract product data from these pages in parallel:
- https://books.toscrape.com/catalogue/category/books/travel_2/index.html
- https://books.toscrape.com/catalogue/category/books/mystery_3/index.html
- https://books.toscrape.com/catalogue/category/books/fiction_10/index.html
For each book: title, price, rating. Return unified JSON array.
Use browser-content.js for page extraction.' \
  --backend sdk --mode decompose --max-depth 1 --max-nodes 8 --concurrency 3

# With live tree visualization
pi-rlm --task 'Extract all book data from https://books.toscrape.com/ as JSON. Use browser-content.js for extraction.' \
  --backend sdk --mode auto --max-depth 2 --max-nodes 12 --live
```

## How It Works

```
User task: "Extract book data from 3 category pages"
         │
    ┌────┴────┐
    │ Planner │  → decides to decompose (one subtask per URL)
    └────┬────┘
         │
    ┌────┼────────────┐
    │    │             │
  ┌─┴─┐ ┌─┴─┐     ┌──┴──┐
  │ S1│ │ S2│     │ S3  │   ← solver nodes run browser-content.js in parallel
  └─┬─┘ └─┬─┘     └──┬──┘
    │    │             │
    └────┼────────────┘
         │
  ┌──────┴──────┐
  │ Synthesizer │  → merges all book data into unified JSON
  └─────────────┘
```

## Key Concepts

- **RLM subtask nodes run with `--no-skills`** — browser tool usage instructions must be embedded in the task description so solver nodes know how to invoke them.
- **Start the browser before the RLM run** — the solver nodes expect Chrome to be running with remote debugging on port 9222.
- **`browser-content.js`** handles JS-rendered pages and outputs clean markdown — best for full-page extraction.
- **`browser-eval.js`** executes JavaScript in the active tab — best for targeted DOM queries and interactions.

## Recommended Settings

| Scenario | `--mode` | `--max-depth` | `--max-nodes` |
|---|---|---|---|
| Single page | `auto` | `2` | `12` |
| Multi-page (parallel) | `decompose` | `1` | `8` |
| Paginated listing | `auto` | `2` | `16` |
