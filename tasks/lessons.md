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
