# Lessons

- Explicitly project allowlisted fields before persistence; TypeScript structural typing permits runtime objects with extra properties that object spread would retain.
- When patching regex Unicode escapes through JavaScript strings, preserve literal backslashes and verify `git diff --numstat` stays textual before testing.
- Never emit placeholder values in metrics output: every reported number is
  measured, or the row explains itself. If a baseline is cheap to measure (an
  extra off-run), measure it rather than rationalizing the gap.
- A measured zero needs its interpretation next to it ("guardrail worked"),
  or it reads as missing data.
- Fetch origin/main before starting a feature batch and again before pushing:
  parallel implementations of the same feature happen. Reconcile by treating
  main as canonical — keep theirs, port only what doesn't exist upstream.

- Treat Codex and Claude Code as first-class peers in setup, transport, authentication, recovery, testing, and release criteria.

- Run long baseline benchmarks from a fixed source/build snapshot. This project deletes dist during each build, so a benchmark sharing the active implementation tree can lose its target CLI mid-run.
- Once a subtask is reported stable, stop editing it and wait for the parent review so the reviewed commit and working tree cannot diverge.
- Size ephemeral learned state by a conservative estimate that includes retained copies and templates, and clear it at lifecycle shutdown; counting only incoming serialized payload understates retained memory. Nested count limits also need an aggregate byte budget because their cross-product can retain far more data than one message.

- Wait for the worker final response before committing its review snapshot; a stable progress update can still precede final self-review edits.
- Verify launch-only native configuration at actual session startup. A management subcommand can ignore launch overrides and cannot establish their precedence.

- A lifecycle window can contain several events. Deduplicate individual event identities; do not consume the entire window or remove it from later ambiguity checks after its first match.

- When elapsed work exceeds expectations, check every agent immediately, report remaining gates honestly, and timebox advisory research. Close bounded implementation phases before opening more edge-case investigations; fix demonstrated correctness gaps without extending optional research.
- A priority invalidation must cross the owner boundary: clearing coordinator learning does not revoke wrapper executor leases or cached results.

- Test network lifecycle completion through explicit events; packet sizes, socket buffering, and short sleeps vary across CI platforms.
- Normalize the actual native child launch with the same platform helpers used by discovery and configuration probes; use explicit portable script formats in fixtures.
- Permission fixtures must seed every managed-policy source they intend to verify, including an empty remote-settings file, rather than relying on platform-specific absence behavior.

- When the user names a successful reference project, use its concrete mechanisms as a design guide while preserving the requested product identity. Do not recast an intentional architectural experiment as unwanted work. Separate adoption evidence, measured results, and transferable design hypotheses.

- Honor the requested team roles explicitly: Astra coordinates scope, integration, and delivery; GPT-5.6 Sol workers implement and review bounded tasks. Reuse the existing Sol workers when the user reiterates this structure.

- Treat context-aware prefetching as Speculate’s established product identity. Assess proxy placement and defaults against that identity; reserve experimental labels for specific unverified capabilities and performance claims.
