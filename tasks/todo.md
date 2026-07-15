# Durable Usage Stats

- [x] Approve design
- [x] Write implementation plan
- [x] Persist and aggregate usage snapshots
  - [x] Add failing default-directory and recorder tests
  - [x] Expose the state directory and implement durable snapshots
  - [x] Add failing validation and aggregation tests
  - [x] Implement strict report validation and aggregation
  - [x] Run focused tests, build, full suite, and self-review
- [ ] Format human and JSON stats
- [ ] Record MCP usage
- [ ] Record CLI usage
- [ ] Register the command and preserve zero-write trials
- [ ] Run focused tests, full tests, and build
- [ ] Review the final diff

## Review

- Task 1 persists owner-only aggregate session snapshots and reports validated totals by source and workspace.
- Focused tests pass 19/19 and the TypeScript build passes.
- The full suite passed 452/453; the unrelated shim timeout passed immediately in isolation.
