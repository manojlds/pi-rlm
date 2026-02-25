#!/bin/bash
#
# Quickstart: The simplest possible RLM demo.
#
# Creates a tiny file and runs the RLM on it. Takes ~30 seconds.
# Watch the REPL iterations in your terminal.
#

set -euo pipefail
cd "$(dirname "$0")/.."

echo "╔══════════════════════════════════════════════════════╗"
echo "║  RLM Quickstart — minimal demo                      ║"
echo "╚══════════════════════════════════════════════════════╝"
echo ""

# Create a tiny inline context — no external files needed
TMPFILE=$(mktemp /tmp/rlm-quickstart-XXXXXX.txt)

python3 -c "
import random, hashlib
random.seed(99)
# 200 lines, each with a random number. One line has a special marker.
for i in range(200):
    if i == 137:
        print(f'line {i}: MAGIC_NUMBER={2**16 + 7} status=active checksum={hashlib.md5(b\"magic\").hexdigest()}')
    else:
        print(f'line {i}: value={random.randint(1,9999)} status={random.choice([\"active\",\"inactive\"])} checksum={hashlib.md5(str(i).encode()).hexdigest()}')
" > "$TMPFILE"

echo "Created test file: $TMPFILE (200 lines)"
echo "Hidden: MAGIC_NUMBER=65543 on line 137"
echo ""
echo "Running: pi -e ./src/index.ts -p '...find the MAGIC_NUMBER...'"
echo "─────────────────────────────────────────────────────────"
echo ""

pi -e ./src/index.ts -p \
  "Use the rlm tool to find the MAGIC_NUMBER value in this file. Search through the data and return the exact number. Context: file:$TMPFILE"

echo ""
echo "─────────────────────────────────────────────────────────"
echo "Expected answer: 65543"

rm -f "$TMPFILE"
