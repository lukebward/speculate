# Durable Usage Stats

- [x] Approve design
- [x] Write implementation plan
- [x] Persist and aggregate usage snapshots
  - [x] Add failing default-directory and recorder tests
  - [x] Expose the state directory and implement durable snapshots
  - [x] Add failing validation and aggregation tests
  - [x] Implement strict report validation and aggregation
  - [x] Project recorder updates onto the approved counter schema
  - [x] Run focused tests, build, full suite, and self-review
- [x] Format human and JSON stats
  - [x] Add failing parser, formatter, empty-state, and JSON tests
  - [x] Implement argument parsing and deterministic human formatting
  - [x] Implement injectable command execution
  - [x] Run focused tests, build, full suite, and self-review
- [ ] Record MCP usage
- [ ] Record CLI usage
- [ ] Register the command and preserve zero-write trials
- [ ] Run focused tests, full tests, and build
- [ ] Review the final diff

## Review

- Task 1 persists owner-only aggregate session snapshots and reports validated totals by source and workspace.
- Focused tests pass 20/20 and the TypeScript build passes.
- The full suite passed 453/453.
- Task 2 formats cumulative human and exact JSON reports behind an injectable command runner.
- Task 2 focused tests pass 21/21, the TypeScript build passes, and the full suite passes 465/465.
