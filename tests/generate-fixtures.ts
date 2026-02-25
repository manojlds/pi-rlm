/**
 * Generate test fixture files for RLM integration tests.
 *
 * These are designed so that the correct answer REQUIRES code execution —
 * an LLM cannot compute the answer from reasoning alone.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const FIXTURES_DIR = join(import.meta.dirname ?? __dirname, "fixtures");

// ── Test 1: Sum of numbers in a large CSV ──────────────────────────────
// 5000 rows of random numbers. The LLM cannot mentally sum 5000 numbers.
function generateSumCSV() {
  const rows: string[] = ["id,category,value,noise"];
  let expectedSum = 0;
  const categories = ["alpha", "beta", "gamma", "delta", "epsilon"];

  for (let i = 1; i <= 5000; i++) {
    const category = categories[i % categories.length];
    const value = Math.floor(Math.random() * 1000) - 500; // -500 to 499
    const noise = (Math.random() * 100).toFixed(2);
    expectedSum += value;
    rows.push(`${i},${category},${value},${noise}`);
  }

  writeFileSync(join(FIXTURES_DIR, "numbers.csv"), rows.join("\n"), "utf-8");
  writeFileSync(
    join(FIXTURES_DIR, "numbers-expected.json"),
    JSON.stringify({ sum_of_value_column: expectedSum, row_count: 5000 }),
    "utf-8"
  );
  console.log(`✓ numbers.csv: 5000 rows, expected sum = ${expectedSum}`);
}

// ── Test 2: Needle in haystack — find a hidden token ───────────────────
// 50K lines of random text with a single hidden "SECRET_TOKEN_XYZ_<hash>" on a random line.
function generateNeedleHaystack() {
  const lines: string[] = [];
  const totalLines = 50000;
  const needleLine = Math.floor(Math.random() * totalLines);
  const token = `SECRET_TOKEN_XYZ_${createHash("md5").update(String(Date.now())).digest("hex").slice(0, 12)}`;

  for (let i = 0; i < totalLines; i++) {
    if (i === needleLine) {
      lines.push(`[${i}] log entry: session initialized with token=${token} at timestamp=1706000000`);
    } else {
      // Random-looking log lines
      const level = ["INFO", "DEBUG", "WARN", "TRACE"][i % 4];
      const module = ["auth", "db", "api", "cache", "queue"][i % 5];
      lines.push(
        `[${i}] ${level} ${module}: operation completed in ${Math.floor(Math.random() * 500)}ms, ` +
        `request_id=${Math.random().toString(36).slice(2, 14)}`
      );
    }
  }

  writeFileSync(join(FIXTURES_DIR, "haystack.log"), lines.join("\n"), "utf-8");
  writeFileSync(
    join(FIXTURES_DIR, "haystack-expected.json"),
    JSON.stringify({ token, line_number: needleLine }),
    "utf-8"
  );
  console.log(`✓ haystack.log: ${totalLines} lines, needle at line ${needleLine}, token = ${token}`);
}

// ── Test 3: Count specific patterns ────────────────────────────────────
// A file with various error codes. Ask for exact counts per error code.
function generateErrorCounts() {
  const errorCodes = ["E001", "E002", "E003", "E004", "E005"];
  const counts: Record<string, number> = {};
  errorCodes.forEach((c) => (counts[c] = 0));

  const lines: string[] = [];
  for (let i = 0; i < 10000; i++) {
    const code = errorCodes[Math.floor(Math.random() * errorCodes.length)];
    counts[code]++;
    lines.push(
      `${new Date(1700000000000 + i * 60000).toISOString()} [${code}] ` +
      `Failed to process request from ${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.` +
      `${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}: ` +
      `${["timeout", "connection refused", "bad gateway", "rate limited", "internal error"][Math.floor(Math.random() * 5)]}`
    );
  }

  writeFileSync(join(FIXTURES_DIR, "errors.log"), lines.join("\n"), "utf-8");
  writeFileSync(
    join(FIXTURES_DIR, "errors-expected.json"),
    JSON.stringify({ counts, total: 10000 }),
    "utf-8"
  );
  console.log(`✓ errors.log: 10000 entries, counts = ${JSON.stringify(counts)}`);
}

// ── Test 4: Multi-step aggregation ─────────────────────────────────────
// JSON data that requires grouping + averaging — can't be eyeballed.
function generateAggregation() {
  const departments = ["engineering", "sales", "marketing", "support", "hr"];
  const entries: Array<{ name: string; department: string; salary: number; tenure_years: number }> = [];

  for (let i = 0; i < 2000; i++) {
    const dept = departments[Math.floor(Math.random() * departments.length)];
    entries.push({
      name: `employee_${i}`,
      department: dept,
      salary: 50000 + Math.floor(Math.random() * 100000),
      tenure_years: Math.floor(Math.random() * 20),
    });
  }

  // Compute expected results
  const byDept: Record<string, { totalSalary: number; count: number; totalTenure: number }> = {};
  for (const e of entries) {
    if (!byDept[e.department]) byDept[e.department] = { totalSalary: 0, count: 0, totalTenure: 0 };
    byDept[e.department].totalSalary += e.salary;
    byDept[e.department].count++;
    byDept[e.department].totalTenure += e.tenure_years;
  }

  const expected: Record<string, { avg_salary: number; avg_tenure: number; count: number }> = {};
  for (const [dept, data] of Object.entries(byDept)) {
    expected[dept] = {
      avg_salary: Math.round(data.totalSalary / data.count),
      avg_tenure: parseFloat((data.totalTenure / data.count).toFixed(1)),
      count: data.count,
    };
  }

  writeFileSync(join(FIXTURES_DIR, "employees.json"), JSON.stringify(entries, null, 2), "utf-8");
  writeFileSync(join(FIXTURES_DIR, "employees-expected.json"), JSON.stringify(expected, null, 2), "utf-8");
  console.log(`✓ employees.json: ${entries.length} employees across ${departments.length} departments`);
}

// Generate all fixtures
generateSumCSV();
generateNeedleHaystack();
generateErrorCounts();
generateAggregation();

console.log("\n✓ All fixtures generated in tests/fixtures/");
