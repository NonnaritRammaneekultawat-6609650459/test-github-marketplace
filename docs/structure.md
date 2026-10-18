# Repository structure

```text
test-github-marketplace/
├── action.yml                 GitHub Action inputs and bundled entry point
├── generate-tests.js          Stable CLI/build entry (loads lib/gate.js)
├── lib/
│   ├── gate.js                Original orchestration, Gemini, audit and PR publishing
│   ├── angularjs/
│   │   ├── adapter.js         Context collection, result validation and reporting
│   │   ├── generation.js      AI test prompt, manifests, discovery and isolated execution
│   │   └── harness.js         Action-owned AngularJS/jsdom test helper
│   ├── prompts/
│   │   └── jest.js            Original JavaScript/Jest test-generation prompt
│   └── reporting/
│       ├── angularjs.js       Markdown for tests, security and AI sections
│       └── pr-comments.js     Idempotent publication and cross-links
├── tests/
│   ├── angularjs.cjs          Regression tests for the Action itself
│   └── reporting.cjs          Comment formatting and repeat-publication tests
├── docs/
│   ├── angularjs.md           Generated-test workflow and setup
│   └── structure.md           This map
├── dist/index.js              Built bundle executed by GitHub; do not edit directly
├── src/                      Existing JavaScript sample for the legacy workflow
└── .github/workflows/         Repository automation
```

`src/` and the root coverage/audit/Sonar configuration remain in place for the
existing JavaScript demonstration. Production Action implementation belongs in
`lib/`; tests for the Action belong in `tests/`. AngularJS consumer projects need
neither directory. Their generated suites live in workflow artifacts and the
execution runner's temporary runtime, not in committed application files.

Run `npm run test:angularjs` to verify the Action and `npm run build` to rebuild
the distributable. `node generate-tests.js` remains the public CLI entry point.
