# AngularJS: tests owned by the Action

The original generate-tests.js entry point supports AngularJS projects without
consumer test files, npm test/check scripts, jsdom or test configuration.
Set project_type: angularjs and test_source: generated (the default).

Run three separate GitHub Actions jobs, pinning this action to the same commit:

1. generate: no PR checkout. Pass the Gemini secret and a read-only GitHub token.
   The action reads source through GitHub APIs, reuses the Gemini review pipeline,
   and creates .aq-generated/generated.test.cjs plus a commit-bound manifest.
   Upload .aq-generated/ as aq-generated-tests, including hidden files.
2. checks: checkout the exact PR head with persist-credentials: false. Install
   application dependencies with npm ci --ignore-scripts. Download the generated
   artifact to .aq-generated/. Call phase: checks with install_status. No AI
   secret or write token belongs in this job. Upload .gate-state.json as
   quality-gate-results, including hidden files.
3. report: no PR checkout. Download both artifacts, then call phase: report with
   github_token and report_only: true. The action validates commit identities,
   formats generated test results and the saved AI review, and updates three PR
   comments: Test Results, Security Audit and AI Code Review. Each has navigation
   links; reruns update the same bot comments instead of adding duplicates.

Use if: always() for artifact collection and reporting so generation or test
failures still produce a comment. Artifact download failures may continue to
allow an unavailable-results report. The base-branch workflow can use
pull_request_target only with this isolation; never execute PR code or generated
tests in a job holding Gemini credentials or a write token.

## Runtime

The Action installs its pinned jsdom runtime in runner temporary storage. It
provides a harness that loads the consumer's AngularJS package and discovers JS
files in src/, preferring index.html script order. The ng-app attribute selects
the root module, with angular.module declarations as fallback. The generated
suite uses Node's test runner and the Action's setup helper. It never needs to
be committed into the application repository. Generated files and output are
available through workflow artifacts. Dependencies outside the demo's supported
bootstrap pattern may need additional setup; errors are reported, not hidden.

The Action checks JS syntax directly and reuses its npm audit implementation.
Its assertion helper compares plain Object/Array data across Node and jsdom
realms while preserving value, sparse-array, custom-class and reference checks.
The generator normalizes strict-assert imports to that helper, never assertions
or expected results. Storage failures use the harness's failStorageWrites helper.
A failing test remains failed; no app code is rewritten and failing assertions
are not automatically weakened. Missing keys, malformed AI output, empty suites,
missing or stale artifacts and timeouts do not count as passing tests.
Coverage and SonarCloud remain deferred in this AngularJS mode.

Existing-test users can explicitly choose test_source: existing to retain the
previous two-job setup. JavaScript/Jest projects keep the original path.

Run npm run test:angularjs and npm run build before publishing. GitHub executes
the committed dist/index.js bundle, including the harness and generator.
