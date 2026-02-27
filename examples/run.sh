#!/bin/bash
#
# Run RLM examples interactively with pi.
#
# Usage:
#   ./examples/run.sh                  # List available examples
#   ./examples/run.sh sales            # Run the sales analysis example
#   ./examples/run.sh logs             # Run the log investigation example
#   ./examples/run.sh puzzle           # Run the cipher puzzle example
#   ./examples/run.sh configs          # Run the config diff example
#   ./examples/run.sh all              # Run all examples sequentially
#
# By default, examples rely on project autoload (`.pi/extensions/rlm/index.ts`).
# If you want explicit loading instead, run with:
#   PI_RLM_LOAD_MODE=explicit ./examples/run.sh <example>
#
# Prerequisites:
#   - pi CLI installed and configured
#   - Python 3 available
#

set -euo pipefail
cd "$(dirname "$0")/.."

CYAN='\033[0;36m'
YELLOW='\033[1;33m'
GREEN='\033[0;32m'
DIM='\033[2m'
NC='\033[0m'

# Generate example data if not present
if [ ! -f examples/sales.csv ]; then
  echo "Generating example data..."
  python3 examples/generate-examples.py
  echo ""
fi

ROOT_DIR="$(pwd)"
EXAMPLES_DIR="${ROOT_DIR}/examples"

PI_CMD=(pi)
PI_RUN_CWD="$ROOT_DIR"
if [ "${PI_RLM_LOAD_MODE:-autoload}" = "explicit" ]; then
  PI_CMD=(pi -e "${ROOT_DIR}/src/index.ts")
  # Run outside repo root so project autoload does not double-register tools.
  PI_RUN_CWD="/tmp"
fi

run_pi_prompt() {
  local prompt="$1"
  (
    cd "$PI_RUN_CWD"
    "${PI_CMD[@]}" -p "$prompt"
  )
}

# ── Example definitions ────────────────────────────────────────────────

run_sales() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  Example: Sales Data Analysis (2000 rows)                   ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}This CSV has 2000 sales records with product, region, units, and price.${NC}"
  echo -e "${DIM}The RLM must use Python to compute revenue = units × price, group by${NC}"
  echo -e "${DIM}product and region, and find the top performers. No LLM can mentally${NC}"
  echo -e "${DIM}multiply and sum 2000 rows.${NC}"
  echo ""
  echo -e "${YELLOW}Query: What is the total revenue, top product by revenue, and top region?${NC}"
  echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
  echo ""

  run_pi_prompt "Use the rlm tool to analyze this sales CSV file. Calculate:
1. Total revenue (units × price_each for each row, then sum all)
2. Which product has the highest total revenue?
3. Which region has the highest total revenue?

Context: file:${EXAMPLES_DIR}/sales.csv"
}

run_logs() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  Example: Server Log Investigation (5000 lines)             ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}A server log with 5000 entries from multiple services. Buried inside:${NC}"
  echo -e "${DIM}  • A burst of payment failures (lines ~2200-2250)${NC}"
  echo -e "${DIM}  • A critical SSL certificate expiry warning (line ~3500)${NC}"
  echo -e "${DIM}The RLM must search/grep through the logs to find these patterns.${NC}"
  echo ""
  echo -e "${YELLOW}Query: Find the most critical issues in these logs.${NC}"
  echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
  echo ""

  run_pi_prompt "Use the rlm tool to investigate these server logs. Find:
1. Any burst of errors from a single service (multiple errors in a short time)
2. Any CRITICAL level messages
3. What are the most concerning patterns?

Provide specific details: which service, what error, how many occurrences.

Context: file:${EXAMPLES_DIR}/server.log"
}

run_puzzle() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  Example: Cipher Puzzle (ROT13 + Base64)                    ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}A message encoded with ROT13 then Base64, buried in noise text.${NC}"
  echo -e "${DIM}The RLM must:${NC}"
  echo -e "${DIM}  1. Find the encoded string in the file${NC}"
  echo -e "${DIM}  2. Base64-decode it${NC}"
  echo -e "${DIM}  3. ROT13-decode the result${NC}"
  echo -e "${DIM}This is impossible without code execution — LLMs can't do Base64 in${NC}"
  echo -e "${DIM}their heads reliably.${NC}"
  echo ""
  echo -e "${YELLOW}Query: Decode the hidden message.${NC}"
  echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
  echo ""

  run_pi_prompt "Use the rlm tool to decode the hidden message in this file. The file contains an encoded message somewhere — it was encoded with ROT13 and then Base64. Find it, decode it, and return the plaintext.

Context: file:${EXAMPLES_DIR}/puzzle.txt"
}

run_configs() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  Example: Configuration Diff (JSON comparison)              ║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}Two large JSON configurations (production vs staging) with ~50 feature${NC}"
  echo -e "${DIM}flags each. There are exactly 10 differences: changed values, a removed${NC}"
  echo -e "${DIM}key, and an added section. The RLM must parse both JSON objects and${NC}"
  echo -e "${DIM}programmatically diff them.${NC}"
  echo ""
  echo -e "${YELLOW}Query: Find all differences between the two configs.${NC}"
  echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
  echo ""

  run_pi_prompt "Use the rlm tool to compare the two JSON configurations in this file (PRODUCTION CONFIG vs STAGING CONFIG). Find ALL differences:
- Values that changed
- Keys that were added
- Keys that were removed

List each difference with the path, old value, and new value.

Context: file:${EXAMPLES_DIR}/configs.txt"
}

run_papers() {
  echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
  echo -e "${CYAN}║  Example: Research Papers Analysis (semantic, uses llm_query)║${NC}"
  echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
  echo ""
  echo -e "${DIM}15 research paper abstracts across 5 topics, with peer review${NC}"
  echo -e "${DIM}discussion text (~150K chars total). The task requires SEMANTIC${NC}"
  echo -e "${DIM}understanding — Python grep can't synthesize research themes.${NC}"
  echo -e "${DIM}The RLM must chunk the corpus and use llm_query() to analyze${NC}"
  echo -e "${DIM}each paper's contributions, then aggregate findings.${NC}"
  echo ""
  echo -e "${YELLOW}Query: Identify cross-cutting themes and novel techniques across papers.${NC}"
  echo -e "${DIM}─────────────────────────────────────────────────────────────────${NC}"
  echo ""

  run_pi_prompt "Use the rlm tool to analyze this corpus of research papers. The corpus is too large to read at once, so you MUST:
1. Split the corpus into individual papers
2. Use llm_query() or llm_query_batched() to semantically analyze each paper's key contribution and technique
3. Synthesize the results to find cross-cutting themes across all 5 topic areas
4. Identify which papers introduce techniques that could be applied to other topic areas

This task REQUIRES using llm_query() for semantic analysis — Python string matching alone cannot synthesize research themes.

Context: file:${EXAMPLES_DIR}/papers.txt"
}

# ── Main ────────────────────────────────────────────────────────────────

show_help() {
  echo -e "${CYAN}RLM Extension Examples${NC}"
  echo ""
  echo "Usage: ./examples/run.sh <example>"
  echo ""
  echo "Available examples:"
  echo -e "  ${GREEN}sales${NC}     — Analyze 2000-row sales CSV (revenue, top product/region)"
  echo -e "  ${GREEN}logs${NC}      — Investigate 5000-line server log (find error patterns)"
  echo -e "  ${GREEN}puzzle${NC}    — Decode a ROT13+Base64 cipher (requires code execution)"
  echo -e "  ${GREEN}configs${NC}   — Diff two large JSON configs (find 10 differences)"
  echo -e "  ${GREEN}papers${NC}    — Analyze 15 research papers (uses llm_query sub-calls)"
  echo -e "  ${GREEN}all${NC}       — Run all examples sequentially"
  echo ""
  echo "Each example runs pi with the RLM extension and a task that"
  echo "requires the Python REPL — you'll see the iterations in real time."
  echo ""
  echo "Load mode: autoload (default). Override with PI_RLM_LOAD_MODE=explicit."
}

case "${1:-}" in
  sales)    run_sales ;;
  logs)     run_logs ;;
  puzzle)   run_puzzle ;;
  configs)  run_configs ;;
  papers)   run_papers ;;
  all)
    run_sales
    echo -e "\n\n"
    run_logs
    echo -e "\n\n"
    run_puzzle
    echo -e "\n\n"
    run_configs
    echo -e "\n\n"
    run_papers
    ;;
  *)        show_help ;;
esac
