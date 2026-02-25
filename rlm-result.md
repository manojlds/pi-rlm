Done! I've written the one-line descriptions for each file to `/home/manojlds/projects/pi-rlm/rlm-result.md`:

- **src/index.ts** - Main extension entry point that registers the "rlm" tool with the pi coding agent, providing a user interface with live visualization and result rendering.

- **src/rlm-engine.ts** - Core RLM implementation providing a persistent Python REPL environment for analyzing large contexts, with support for llm_query, llm_query_batched, rlm_query, and FINAL/SUBMIT functions.