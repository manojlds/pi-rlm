#!/usr/bin/env python3
"""Generate example data files for the RLM demos."""

import random
import hashlib
import json
import os

DIR = os.path.dirname(os.path.abspath(__file__))

# ── Example 1: Sales data CSV ──────────────────────────────────────────
# 2000 rows of sales data. Ask questions that require computation.
random.seed(42)
products = ["Widget A", "Widget B", "Gadget X", "Gadget Y", "Doohickey", "Thingamajig"]
regions = ["North", "South", "East", "West"]

rows = ["date,product,region,units,price_each"]
for i in range(2000):
    month = random.randint(1, 12)
    day = random.randint(1, 28)
    product = random.choice(products)
    region = random.choice(regions)
    units = random.randint(1, 100)
    price = round(random.uniform(5.0, 200.0), 2)
    rows.append(f"2024-{month:02d}-{day:02d},{product},{region},{units},{price}")

with open(os.path.join(DIR, "sales.csv"), "w") as f:
    f.write("\n".join(rows))

# Compute the answer for reference
total_revenue = 0
by_product = {}
by_region = {}
for row in rows[1:]:
    parts = row.split(",")
    product, region = parts[1], parts[2]
    units, price = int(parts[3]), float(parts[4])
    rev = units * price
    total_revenue += rev
    by_product[product] = by_product.get(product, 0) + rev
    by_region[region] = by_region.get(region, 0) + rev

top_product = max(by_product, key=by_product.get)
top_region = max(by_region, key=by_region.get)
print(f"✓ sales.csv: 2000 rows")
print(f"  Total revenue: ${total_revenue:,.2f}")
print(f"  Top product: {top_product} (${by_product[top_product]:,.2f})")
print(f"  Top region: {top_region} (${by_region[top_region]:,.2f})")

# ── Example 2: Server logs with hidden error pattern ───────────────────
# 5000 log lines with a specific failure pattern buried in the middle.
random.seed(123)
log_lines = []
error_timestamps = []
for i in range(5000):
    ts = f"2024-03-15T{random.randint(0,23):02d}:{random.randint(0,59):02d}:{random.randint(0,59):02d}.{random.randint(0,999):03d}Z"
    level = random.choices(["INFO", "DEBUG", "WARN", "ERROR"], weights=[60, 25, 10, 5])[0]
    service = random.choice(["auth-svc", "api-gateway", "user-svc", "payment-svc", "cache-svc"])

    if 2200 <= i <= 2250 and service == "payment-svc":
        # Hidden burst of payment failures
        level = "ERROR"
        log_lines.append(f"{ts} [{level}] {service}: Transaction failed - insufficient_funds err_code=PAY_402 correlation_id=txn_{i}")
        error_timestamps.append(ts)
    elif i == 3500:
        # Single critical error
        log_lines.append(f"{ts} [CRITICAL] auth-svc: SSL certificate expired for *.api.internal.com - connections will fail")
    else:
        messages = {
            "INFO": [f"Request processed in {random.randint(10,500)}ms", f"Health check OK", f"Connection pool: {random.randint(5,50)} active"],
            "DEBUG": [f"Cache hit ratio: {random.uniform(0.5,0.99):.2f}", f"Query plan optimized: {random.randint(1,20)} tables"],
            "WARN": [f"Response time {random.randint(500,2000)}ms exceeds threshold", f"Retry attempt {random.randint(1,3)} for upstream"],
            "ERROR": [f"Connection timeout after {random.randint(5,30)}s", f"Rate limit exceeded for client {random.randint(100,999)}"],
        }
        msg = random.choice(messages[level])
        log_lines.append(f"{ts} [{level}] {service}: {msg}")

with open(os.path.join(DIR, "server.log"), "w") as f:
    f.write("\n".join(log_lines))

print(f"\n✓ server.log: 5000 lines")
print(f"  Hidden: payment failure burst at lines 2200-2250")
print(f"  Hidden: SSL cert expiry at line 3500")

# ── Example 3: Encrypted message puzzle ────────────────────────────────
# A Caesar cipher + base64 encoded message. Must use code to decode.
import base64

secret = "The launch code is ALPHA-7749-BRAVO"
# Caesar shift by 13 (ROT13)
rotated = secret.translate(str.maketrans(
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
    "NOPQRSTUVWXYZABCDEFGHIJKLMnopqrstuvwxyzabcdefghijklm"
))
encoded = base64.b64encode(rotated.encode()).decode()

puzzle = f"""=== ENCODED MESSAGE ===
The following message has been encoded with ROT13 and then Base64:

{encoded}

Additional context:
- First apply Base64 decoding
- Then apply ROT13 decoding
- The result is a plaintext English sentence containing a code
=== END ===
"""

# Pad with distracting text
filler = "\n".join([
    f"Log entry {i}: System nominal, sensor reading {random.uniform(0, 100):.4f}, "
    f"checksum {hashlib.md5(str(i).encode()).hexdigest()}"
    for i in range(500)
])

with open(os.path.join(DIR, "puzzle.txt"), "w") as f:
    f.write(filler[:10000] + "\n\n" + puzzle + "\n\n" + filler[10000:20000])

print(f"\n✓ puzzle.txt: encoded message buried in noise")
print(f"  Secret: {secret}")
print(f"  Encoded: {encoded}")

# ── Example 4: JSON config diff ────────────────────────────────────────
# Two large JSON configs — find all differences.
base_config = {
    "server": {
        "host": "0.0.0.0", "port": 8080, "workers": 4,
        "timeout_ms": 30000, "max_connections": 1000,
        "ssl": {"enabled": True, "cert": "/etc/ssl/cert.pem", "key": "/etc/ssl/key.pem"},
    },
    "database": {
        "primary": {"host": "db-primary.internal", "port": 5432, "pool_size": 20, "ssl": True},
        "replica": {"host": "db-replica.internal", "port": 5432, "pool_size": 10, "ssl": True},
        "migrations": {"auto_run": False, "directory": "./migrations"},
    },
    "cache": {"provider": "redis", "host": "cache.internal", "port": 6379, "ttl_seconds": 3600},
    "logging": {"level": "info", "format": "json", "outputs": ["stdout", "file"]},
    "features": {f"feature_{i}": random.choice([True, False]) for i in range(50)},
}

modified_config = json.loads(json.dumps(base_config))
# Introduce specific changes
modified_config["server"]["port"] = 9090                    # Changed
modified_config["server"]["workers"] = 8                     # Changed
modified_config["server"]["ssl"]["enabled"] = False          # Changed
modified_config["database"]["primary"]["pool_size"] = 50     # Changed
modified_config["database"]["replica"]["host"] = "db-replica-v2.internal"  # Changed
modified_config["database"]["migrations"]["auto_run"] = True # Changed
modified_config["cache"]["ttl_seconds"] = 7200               # Changed
modified_config["logging"]["level"] = "debug"                # Changed
del modified_config["logging"]["outputs"]                    # Removed
modified_config["monitoring"] = {"enabled": True, "endpoint": "/metrics"}  # Added

diff_text = f"""=== CONFIGURATION COMPARISON ===

--- PRODUCTION CONFIG ---
{json.dumps(base_config, indent=2)}

--- STAGING CONFIG ---
{json.dumps(modified_config, indent=2)}

=== END ===
"""

with open(os.path.join(DIR, "configs.txt"), "w") as f:
    f.write(diff_text)

print(f"\n✓ configs.txt: two JSON configs with 10 differences")
print(f"  Changes: port, workers, ssl, pool_size, replica host, auto_run, ttl, log level, outputs removed, monitoring added")

print(f"\n✓ All example data generated in examples/")
