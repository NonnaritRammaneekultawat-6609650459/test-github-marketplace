# Test specifications

The JavaScript quality gate loads specifications from this folder when it generates tests.

- A file-level spec mirrors the source path and changes .js to .md.
  - src/math.js uses docs/specs/src/math.md.
  - src/security_vulnerable.js uses docs/specs/src/security_vulnerable.md.
- docs/specs/project.md is shared by every generated test.
- Both the matching file-level spec and the project spec are included when present.
- Keep each spec under 20 KB.

Write behavior requirements, expected inputs and outputs, error cases, and edge cases. A file-level spec applies only to its matching source file.
