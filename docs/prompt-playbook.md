# Prompt Playbook

Objective quality strongly affects recursive decomposition and synthesis quality.

---

## High-signal objective patterns

### Review: security-focused

```text
Perform a deep repository security review.
Focus on authn/authz boundaries, secret handling, injection surfaces, unsafe deserialization, and privilege escalation paths.
Provide ranked findings with concrete evidence and fixes.
```

### Review: reliability-focused

```text
Perform a reliability and correctness review.
Focus on error handling, retry/idempotency behavior, race conditions, state consistency, and edge-case validation.
Prioritize defects likely to impact production stability.
```

### Wiki: architecture-focused

```text
Generate an architecture wiki for this repository.
Map modules to responsibilities, identify data/control flow between components, and highlight coupling hotspots and modernization opportunities.
```

### Generic exploration

```text
Recursively explore this repository and build a structured map of key subsystems.
Identify high-risk areas, unknowns, and recommended next investigations.
```

---

## Prompt tuning tips

- Be explicit about **domain focus** (security/perf/reliability/docs).
- State expected output style (ranked findings, remediation plan, architecture map).
- Add constraints (e.g., "ground claims in code evidence").
- For semantic synthesis, choose a stronger model with `semantic_model` when needed.

---

## Suggested end-to-end prompt flow

1. Start run objective (detailed and scoped)
2. Run recursion to completion/budget
3. Synthesize deterministic artifacts
4. Optionally synthesize semantic narrative
5. Export for human + CI consumption
