# Lessons

- Explicitly project allowlisted fields before persistence; TypeScript structural typing permits runtime objects with extra properties that object spread would retain.
- When patching regex Unicode escapes through JavaScript strings, preserve literal backslashes and verify `git diff --numstat` stays textual before testing.
