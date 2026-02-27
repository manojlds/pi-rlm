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

# ── Example 5: Research papers corpus (requires llm_query for semantic analysis) ──
# Multiple "research paper abstracts" on different topics. The task requires
# SEMANTIC understanding — Python grep alone can't synthesize themes across papers.
random.seed(777)

topics = [
    ("distributed systems", [
        "We present a novel consensus protocol for geo-distributed databases that achieves sub-100ms commit latencies while maintaining strict serializability. Our approach, called FastPaxos-GD, extends Multi-Paxos with speculative execution and regional quorum optimizations. In a 5-region deployment across AWS, we measured 67ms median commit latency (p99: 142ms), a 3.2x improvement over standard Multi-Paxos. The key insight is that most transactions access data within a single region, allowing us to use fast-path local commits for 87% of operations. Cross-region transactions use a two-phase protocol with pipelined prepare messages. We prove that our protocol maintains linearizability under all network partition scenarios. Evaluation on TPC-C shows 45,000 transactions/second with 5 replicas, compared to 14,000 for CockroachDB and 28,000 for Spanner-like systems.",
        "This paper addresses the challenge of live migration for stateful stream processing operators across edge computing nodes. Current approaches require pausing the operator during state transfer, causing latency spikes of 500ms-2s. We propose StreamMove, a technique that uses dual-write logging and incremental state synchronization to achieve zero-downtime migration. During migration, both source and destination nodes process incoming events, with a reconciliation protocol ensuring exactly-once semantics. Our evaluation on Apache Flink shows migration times of 200ms-1.5s depending on state size (1MB-1GB), with zero observable latency impact on downstream operators. We demonstrate the system handling 500K events/second during migration without data loss. The approach is applicable to any operator with checkpoint-serializable state.",
        "We study the problem of resource allocation in heterogeneous computing clusters where nodes have varying CPU, memory, and GPU capabilities. Traditional bin-packing schedulers like Kubernetes' default scheduler achieve only 62% average utilization. We introduce HeteroSched, a reinforcement learning-based scheduler that learns placement policies from historical workload patterns. HeteroSched uses a graph neural network to encode cluster topology and workload dependencies, producing placement decisions in under 5ms. On a 200-node cluster running mixed ML training and web serving workloads, HeteroSched achieves 84% average utilization (vs 62% default, 71% Volcano scheduler). It also reduces job completion time by 28% for ML training workloads by learning GPU affinity patterns. The model is trained online with a replay buffer, adapting to changing workload mixes within 2 hours.",
    ]),
    ("machine learning", [
        "We propose Sparse Mixture-of-Experts Attention (SMoE-Attn), an architecture that replaces dense self-attention with a learned routing mechanism directing each token to a subset of specialized attention heads. Unlike standard MoE applied to FFN layers, our approach applies mixture-of-experts to the attention computation itself. Each expert head specializes in different attention patterns: local, global, positional, and semantic. On language modeling benchmarks, a 7B parameter SMoE-Attn model matches the performance of a 13B dense transformer while using 40% fewer FLOPs at inference. The routing overhead is negligible (0.3% additional compute) since the router is a simple linear projection. We observe emergent specialization: head clusters automatically learn syntactic (nearby tokens), semantic (related concepts), and positional (fixed-distance) attention patterns without explicit supervision.",
        "Fine-tuning large language models on domain-specific data often causes catastrophic forgetting of general capabilities. We introduce Elastic Weight Consolidation for LLMs (EWC-LLM), adapting the classic EWC approach to transformer architectures. Our key contribution is an efficient Fisher Information Matrix approximation that requires only 2% additional memory overhead, compared to the full diagonal Fisher which requires storing one scalar per parameter. We evaluate on medical, legal, and code domains: after fine-tuning on 50K domain-specific examples, models retain 94% of original general benchmark performance (vs 71% with standard fine-tuning, 89% with LoRA). The approach is complementary to LoRA and when combined (EWC-LoRA), achieves 97% retention while matching full fine-tuning domain performance. Training overhead is 15% wall-clock time increase.",
        "We investigate the scaling laws governing in-context learning in transformer models. Through controlled experiments on synthetic tasks (linear regression, classification, automata simulation), we find that ICL ability follows a phase transition rather than smooth scaling. Models below a critical size (approximately 350M parameters for our task suite) show near-zero ICL performance, while models above this threshold rapidly approach Bayes-optimal prediction. The critical size scales as O(d^1.5) where d is the intrinsic dimensionality of the task. We also discover that ICL performance is highly sensitive to the formatting of examples — using structured delimiters improves ICL accuracy by 15-40% across all model sizes. These findings suggest that ICL emerges from a specific circuit formation that requires minimum model capacity, rather than being a gradual capability.",
    ]),
    ("security", [
        "We present SideGuard, a hardware-software co-design for mitigating speculative execution side-channel attacks (Spectre variants) with minimal performance overhead. Existing software mitigations (retpoline, LFENCE) incur 10-30% overhead for server workloads. SideGuard introduces a speculative taint tracking mechanism in the CPU pipeline that prevents tainted (speculative) loads from influencing cache state. When a misspeculation is detected, only the tainted cache lines are invalidated, rather than the entire speculative window. On modified gem5 simulations, SideGuard eliminates all known Spectre-V1 and V2 attack vectors while incurring only 2.1% performance overhead on SPEC2017 (vs 14.7% for full retpoline). The hardware cost is approximately 3,200 additional flip-flops per core, a negligible area increase of 0.02%. We prove the security guarantee formally using an information flow type system.",
        "This paper presents the first practical attack against post-quantum lattice-based key encapsulation mechanisms (KEMs) deployed in production TLS. We demonstrate a chosen-ciphertext timing attack against the reference implementation of Kyber-768 running on Intel and ARM processors. The attack exploits a subtle timing variation (2.3ns difference) in the decapsulation rejection sampling step. Using 45,000 carefully crafted ciphertexts, we recover the full secret key in approximately 3 hours on a co-located VM. We responsibly disclosed this to the NIST PQC team and the vulnerability was patched in CRYSTALS-Kyber v3.0.1. The fix adds constant-time comparison and rejection sampling, with 0.8% performance overhead. We discuss implications for PQC deployment and recommend extended constant-time testing as part of certification.",
        "We analyze the security of zero-knowledge proof systems used in modern blockchain rollups (zkRollups). Through formal verification of three production circuits (zkSync Era, Polygon zkEVM, Scroll), we discover 4 soundness bugs that could allow an attacker to forge proofs for invalid state transitions. The most critical bug in [redacted] allows minting arbitrary tokens by exploiting an unconstrained wire in the ECDSA verification circuit. We developed an automated verification framework, zkAudit, that checks common vulnerability patterns: unconstrained variables, under-constrained arithmetic, and missing range checks. zkAudit found all 4 known bugs plus 2 additional low-severity issues in under 30 minutes of analysis time per circuit. All findings were responsibly disclosed and patched. We open-source zkAudit and propose a taxonomy of 12 ZK circuit vulnerability classes.",
    ]),
    ("programming languages", [
        "We introduce Gradual Ownership Types, a type system that smoothly integrates Rust-like ownership and borrowing with traditional garbage-collected programming. Programmers can annotate performance-critical regions with ownership types while leaving the rest of the program dynamically managed. At ownership boundaries, the compiler inserts runtime checks (average overhead: 4ns per crossing) that verify the ownership contract. We implement this in an extension of Java called JOwn, where ownership-annotated code achieves performance within 8% of equivalent Rust code, while unannotated code behaves identically to standard Java. In a case study porting a high-frequency trading system, developers annotated 12% of the codebase (the hot path), achieving a 3.4x latency reduction (from 340μs to 100μs p99) compared to the original Java implementation.",
        "We present Incremental Type Error Recovery, a technique for providing useful type error messages in languages with Hindley-Milner type inference. Current implementations (GHC, OCaml) often report errors far from the actual mistake due to the global nature of unification. Our approach maintains a history of unification steps and, upon failure, uses a SAT-solver-based diagnosis to find the minimum set of program locations that, if changed, would make the program well-typed. On a corpus of 50,000 student Haskell programs with type errors, our technique points to the correct error location 78% of the time (vs 34% for GHC, 41% for OCaml). The diagnostic overhead is acceptable: median 50ms, p99 800ms, compared to base type-checking time of 5-20ms. We implement this as a GHC plugin available on Hackage.",
        "Effect systems have struggled with practical adoption due to syntactic overhead and limited composability. We present EffKt, an effect system for Kotlin that uses intersection and union types to achieve lightweight effect polymorphism. Effects are declared as sealed interfaces and handled with when-expressions, making them familiar to Kotlin developers. The compiler eliminates effect wrappers through specialization, achieving zero-overhead effect handling for monomorphic call sites. In benchmarks, EffKt coroutine-based effects are 2x faster than Kotlin's built-in coroutines for structured concurrency patterns, because the compiler can eliminate suspension points when the effect handler is statically known. We evaluate developer experience through a study with 24 Kotlin developers: 87% found EffKt effects easier to use than explicit Result/Either types for error handling.",
    ]),
    ("databases", [
        "We present LearnedLSM, a system that replaces the level structure of LSM-tree storage engines with a learned model that predicts optimal compaction strategies. Traditional LSM-trees use fixed size ratios (typically T=10) across levels, which is suboptimal for skewed workloads. LearnedLSM trains a lightweight neural network (50K parameters) on access pattern statistics to dynamically adjust level sizes, compaction triggers, and merge policies. On RocksDB, LearnedLSM reduces write amplification by 40% for Zipfian workloads while maintaining equivalent read latency. For uniform workloads, it matches the default policy (within 3%). The model retrains every 10 minutes using recent statistics, with a training cost of 200ms on a single CPU core. We also prove theoretical bounds showing that the learned policy converges to the workload-optimal Dostoevsky configuration within O(log n) retraining epochs.",
        "This paper introduces temporal indexing for event sourcing databases. Event sourcing stores all state changes as an append-only log of events, but querying the state at an arbitrary point in time requires replaying events from the beginning. We propose ChronoIndex, a persistent data structure that maintains a time-indexed snapshot tree with O(log n) point-in-time query complexity. ChronoIndex uses a copy-on-write B+tree variant where each modification creates a new root, and historical roots are indexed by timestamp. On a 100M-event dataset, point-in-time queries complete in 2.3ms (vs 4.5 seconds for replay). The space overhead is 2.1x compared to a plain event log, which we reduce to 1.3x using page-level deduplication. We integrate ChronoIndex into EventStoreDB and PostgreSQL (via an extension), demonstrating compatibility with existing event sourcing frameworks.",
        "Query optimization for heterogeneous data lakes remains challenging because statistics on semi-structured data (JSON, Parquet with nested schemas) are expensive to collect and quickly become stale. We present SkylineOpt, a query optimizer that uses data sketches (HyperLogLog, Count-Min, T-Digest) computed during ingestion to estimate selectivities for arbitrary predicates on nested data. SkylineOpt extends the cascade optimization framework with sketch-aware cardinality estimation rules. On the TPC-DS benchmark adapted for JSON data, SkylineOpt produces plans within 1.3x of optimal (computed by exhaustive enumeration) while taking 15ms optimization time (vs 2.5 seconds for exhaustive). For 78% of queries, SkylineOpt finds the optimal plan. The sketch storage overhead is 0.1% of data size, and sketch updates are lock-free, adding less than 1% overhead to ingestion throughput.",
    ]),
]

# Generate a large corpus with these abstracts + surrounding discussion text
corpus_parts = []
paper_id = 1
all_topic_names = [t[0] for t in topics]

for topic_name, abstracts in topics:
    corpus_parts.append(f"\n{'='*80}")
    corpus_parts.append(f"TOPIC AREA: {topic_name.upper()}")
    corpus_parts.append(f"{'='*80}\n")
    
    for i, abstract in enumerate(abstracts):
        corpus_parts.append(f"--- Paper {paper_id}: [{topic_name}] ---")
        corpus_parts.append(f"Title: Research Paper #{paper_id}")
        corpus_parts.append(f"Authors: {random.choice(['Smith', 'Chen', 'Garcia', 'Kim', 'Patel'])} et al.")
        corpus_parts.append(f"Published: 2024-{random.randint(1,12):02d}")
        corpus_parts.append(f"\nAbstract:\n{abstract}")
        
        # Add filler discussion / review text to bulk up the corpus
        review_scores = [random.uniform(3.0, 5.0) for _ in range(3)]
        corpus_parts.append(f"\nReview Scores: {', '.join(f'{s:.1f}' for s in review_scores)} (avg: {sum(review_scores)/len(review_scores):.1f})")
        
        # Generate substantial filler to make the corpus large enough that
        # the LLM can't just read it all at once in the preview
        discussion_lines = []
        for j in range(80):
            reviewer = random.choice(["Reviewer A", "Reviewer B", "Reviewer C"])
            comment_types = [
                f"The experimental methodology in section {random.randint(2,6)} needs more detail on the baseline comparison setup.",
                f"Figure {random.randint(1,8)} would benefit from error bars showing confidence intervals across {random.randint(3,10)} runs.",
                f"The related work section should discuss {random.choice(['SOSP 2023', 'OSDI 2024', 'SIGMOD 2024', 'NeurIPS 2024', 'ICML 2024'])} papers on similar topics.",
                f"Performance claim of {random.uniform(1.5, 10.0):.1f}x improvement needs statistical significance testing (p-value < 0.05).",
                f"The threat model assumption in section {random.randint(3,5)} about {random.choice(['network partitions', 'Byzantine faults', 'adversarial inputs', 'side channels'])} is too restrictive for real deployments.",
                f"Code availability: authors should provide reproduction scripts. Current artifact only has {random.randint(20,80)}% of claimed experiments.",
                f"Minor: typo on page {random.randint(1,12)}, line {random.randint(1,50)}. Also, reference [{random.randint(1,40)}] has wrong venue name.",
                f"The theoretical analysis in Theorem {random.randint(1,4)} assumes {random.choice(['i.i.d. data', 'bounded gradients', 'convexity', 'stationarity'])} which may not hold in practice.",
            ]
            discussion_lines.append(f"  [{reviewer}] {random.choice(comment_types)}")
        
        corpus_parts.append(f"\nPeer Review Discussion:\n" + "\n".join(discussion_lines))
        corpus_parts.append(f"\n--- End Paper {paper_id} ---\n")
        paper_id += 1

corpus_text = "\n".join(corpus_parts)

with open(os.path.join(DIR, "papers.txt"), "w") as f:
    f.write(corpus_text)

print(f"\n✓ papers.txt: {paper_id - 1} research paper abstracts across {len(topics)} topics ({len(corpus_text)} chars)")
print(f"  Topics: {', '.join(all_topic_names)}")
print(f"  Task: Requires llm_query() to semantically analyze each paper's contributions")

print(f"\n✓ All example data generated in examples/")
