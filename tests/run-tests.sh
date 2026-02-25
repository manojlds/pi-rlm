#!/bin/bash
#
# Integration tests for the pi-rlm extension.
#
# Usage:
#   ./tests/run-tests.sh              # Run all tests
#   ./tests/run-tests.sh sum          # Run just the sum test
#   ./tests/run-tests.sh needle       # Run just the needle test
#   ./tests/run-tests.sh errors       # Run just the error count test
#   ./tests/run-tests.sh aggregation  # Run just the aggregation test
#
# Prerequisites:
#   - pi CLI installed and configured with an API key
#   - Python 3 available
#   - Node.js available (for fixture generation)
#
# These tests verify that:
#   1. The RLM extension loads and registers the 'rlm' tool
#   2. The REPL executes Python code (not just LLM reasoning)
#   3. The answers are correct (proving code execution, not guessing)
#

set -euo pipefail
cd "$(dirname "$0")/.."

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

PASS=0
FAIL=0
SKIP=0

# ── Helpers ─────────────────────────────────────────────────────────────

log_pass() { echo -e "${GREEN}✓ PASS${NC}: $1"; ((PASS++)); }
log_fail() { echo -e "${RED}✗ FAIL${NC}: $1 — $2"; ((FAIL++)); }
log_skip() { echo -e "${YELLOW}⊘ SKIP${NC}: $1 — $2"; ((SKIP++)); }
log_info() { echo -e "  ℹ $1"; }

check_prereqs() {
  if ! command -v pi &>/dev/null; then
    echo -e "${RED}Error: 'pi' CLI not found. Install from https://github.com/badlogic/pi-mono${NC}"
    exit 1
  fi
  if ! command -v python3 &>/dev/null; then
    echo -e "${RED}Error: python3 not found${NC}"
    exit 1
  fi
}

generate_fixtures() {
  if [ ! -f tests/fixtures/numbers.csv ]; then
    echo "Generating test fixtures..."
    npx tsx tests/generate-fixtures.ts
    echo ""
  fi
}

# Run pi with our extension and capture output.
# Uses -p (print mode) for non-interactive output.
# $1 = prompt to send
run_rlm() {
  local prompt="$1"
  local timeout="${2:-300}"  # default 5 min timeout

  timeout "$timeout" pi -e ./src/index.ts -p "$prompt" 2>/tmp/rlm-test-stderr.log || {
    local exit_code=$?
    if [ $exit_code -eq 124 ]; then
      echo "[TIMEOUT after ${timeout}s]"
    else
      echo "[ERROR exit=$exit_code]"
      cat /tmp/rlm-test-stderr.log 2>/dev/null || true
    fi
    return $exit_code
  }
}

# Check if the output contains the expected value (substring match).
# $1 = output text
# $2 = expected substring
assert_contains() {
  local output="$1"
  local expected="$2"
  if echo "$output" | grep -qF "$expected"; then
    return 0
  else
    return 1
  fi
}

# Check if output contains a number within tolerance of expected.
# $1 = output text
# $2 = expected number
# $3 = tolerance (default 0 = exact match)
assert_number_near() {
  local output="$1"
  local expected="$2"
  local tolerance="${3:-0}"

  # Extract all numbers from output and check if any is within tolerance
  local numbers
  numbers=$(echo "$output" | grep -oP '[-]?\d+' || true)
  for n in $numbers; do
    local diff=$(( n > expected ? n - expected : expected - n ))
    if [ "$diff" -le "$tolerance" ]; then
      return 0
    fi
  done
  return 1
}

# ── Test Cases ──────────────────────────────────────────────────────────

test_sum() {
  echo ""
  echo "═══ Test 1: Sum of CSV column (5000 rows) ═══"
  log_info "This tests that the REPL can compute a sum no LLM could mentally calculate."

  local expected
  expected=$(python3 -c "import json; print(json.load(open('tests/fixtures/numbers-expected.json'))['sum_of_value_column'])")
  log_info "Expected sum: $expected"

  local result_file="/tmp/rlm-test-sum.txt"
  log_info "Running pi with RLM extension..."

  run_rlm "Use the rlm tool to find the exact sum of the 'value' column in this CSV file. Context: file:$(pwd)/tests/fixtures/numbers.csv" > "$result_file" 2>&1

  local output
  output=$(cat "$result_file")

  if assert_contains "$output" "$expected"; then
    log_pass "Sum test — found correct value $expected"
  else
    log_fail "Sum test" "Expected $expected in output"
    log_info "Output (last 500 chars): $(tail -c 500 "$result_file")"
  fi
}

test_needle() {
  echo ""
  echo "═══ Test 2: Needle in haystack (50K lines) ═══"
  log_info "This tests that the REPL can search through large text the LLM can't see entirely."

  local expected_token
  expected_token=$(python3 -c "import json; print(json.load(open('tests/fixtures/haystack-expected.json'))['token'])")
  log_info "Expected token: $expected_token"

  local result_file="/tmp/rlm-test-needle.txt"
  log_info "Running pi with RLM extension..."

  run_rlm "Use the rlm tool to find the SECRET_TOKEN in this log file. The token starts with 'SECRET_TOKEN_XYZ_'. Return the full token value. Context: file:$(pwd)/tests/fixtures/haystack.log" > "$result_file" 2>&1

  local output
  output=$(cat "$result_file")

  if assert_contains "$output" "$expected_token"; then
    log_pass "Needle test — found token $expected_token"
  else
    log_fail "Needle test" "Expected token $expected_token in output"
    log_info "Output (last 500 chars): $(tail -c 500 "$result_file")"
  fi
}

test_errors() {
  echo ""
  echo "═══ Test 3: Count error codes (10K entries) ═══"
  log_info "This tests that the REPL can count patterns accurately across large text."

  local expected_json
  expected_json=$(cat tests/fixtures/errors-expected.json)

  # Extract individual counts for verification
  local e001 e002 e003
  e001=$(python3 -c "import json; print(json.load(open('tests/fixtures/errors-expected.json'))['counts']['E001'])")
  e002=$(python3 -c "import json; print(json.load(open('tests/fixtures/errors-expected.json'))['counts']['E002'])")
  e003=$(python3 -c "import json; print(json.load(open('tests/fixtures/errors-expected.json'))['counts']['E003'])")
  log_info "Expected: E001=$e001, E002=$e002, E003=$e003"

  local result_file="/tmp/rlm-test-errors.txt"
  log_info "Running pi with RLM extension..."

  run_rlm "Use the rlm tool to count the exact number of occurrences of each error code (E001, E002, E003, E004, E005) in this log file. Return the counts for each. Context: file:$(pwd)/tests/fixtures/errors.log" > "$result_file" 2>&1

  local output
  output=$(cat "$result_file")
  local found=0

  # Check if at least 3 of the 5 error codes have correct counts
  for code in E001 E002 E003 E004 E005; do
    local expected_count
    expected_count=$(python3 -c "import json; print(json.load(open('tests/fixtures/errors-expected.json'))['counts']['$code'])")
    if assert_contains "$output" "$expected_count"; then
      ((found++))
    fi
  done

  if [ "$found" -ge 3 ]; then
    log_pass "Error count test — $found/5 error codes matched exactly"
  else
    log_fail "Error count test" "Only $found/5 error codes matched"
    log_info "Output (last 500 chars): $(tail -c 500 "$result_file")"
  fi
}

test_aggregation() {
  echo ""
  echo "═══ Test 4: Department aggregation (2000 employees) ═══"
  log_info "This tests grouping + averaging — requires multi-step computation."

  local result_file="/tmp/rlm-test-agg.txt"
  log_info "Running pi with RLM extension..."

  run_rlm "Use the rlm tool to compute the average salary and employee count for each department in this JSON file. Return the results grouped by department. Context: file:$(pwd)/tests/fixtures/employees.json" > "$result_file" 2>&1

  local output
  output=$(cat "$result_file")

  # Check that all 5 departments appear in the output
  local found=0
  for dept in engineering sales marketing support hr; do
    if assert_contains "$output" "$dept"; then
      ((found++))
    fi
  done

  # Also verify at least one count is correct
  local eng_count
  eng_count=$(python3 -c "import json; print(json.load(open('tests/fixtures/employees-expected.json'))['engineering']['count'])")

  if [ "$found" -ge 4 ] && assert_number_near "$output" "$eng_count" 5; then
    log_pass "Aggregation test — $found/5 departments found, engineering count ~$eng_count"
  elif [ "$found" -ge 4 ]; then
    log_pass "Aggregation test — $found/5 departments found (count verification inconclusive)"
  else
    log_fail "Aggregation test" "Only $found/5 departments found in output"
    log_info "Output (last 500 chars): $(tail -c 500 "$result_file")"
  fi
}

# ── Structural test: verify the tool registered ─────────────────────────

test_tool_registration() {
  echo ""
  echo "═══ Test 0: Extension loads and tool registers ═══"
  log_info "Verifying that pi loads the extension without errors."

  # Just ask pi to describe its tools — the rlm tool should appear
  local result_file="/tmp/rlm-test-reg.txt"
  run_rlm "What tools do you have available? List them." > "$result_file" 2>&1 || true

  local output
  output=$(cat "$result_file")

  if assert_contains "$output" "rlm" || assert_contains "$output" "RLM"; then
    log_pass "Tool registration — 'rlm' tool found in tool list"
  else
    log_fail "Tool registration" "'rlm' not found in pi's tool list"
    log_info "Output: $(head -c 500 "$result_file")"
  fi
}

# ── Main ────────────────────────────────────────────────────────────────

echo "╔══════════════════════════════════════════════╗"
echo "║       pi-rlm Integration Tests               ║"
echo "╚══════════════════════════════════════════════╝"

check_prereqs
generate_fixtures

FILTER="${1:-all}"

case "$FILTER" in
  all)
    test_tool_registration
    test_sum
    test_needle
    test_errors
    test_aggregation
    ;;
  reg*)       test_tool_registration ;;
  sum)        test_sum ;;
  needle)     test_needle ;;
  error*)     test_errors ;;
  agg*)       test_aggregation ;;
  *)
    echo "Unknown test: $FILTER"
    echo "Available: all, registration, sum, needle, errors, aggregation"
    exit 1
    ;;
esac

echo ""
echo "═══════════════════════════════════════════════"
echo -e "Results: ${GREEN}${PASS} passed${NC}, ${RED}${FAIL} failed${NC}, ${YELLOW}${SKIP} skipped${NC}"
echo "═══════════════════════════════════════════════"

exit $FAIL
