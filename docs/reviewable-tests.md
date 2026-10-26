# Reviewable tests and coverage

New installations use three isolated jobs for both JavaScript/Jest and AngularJS:

1. **generate** reads PR source through GitHub APIs and calls the selected AI. It
   checks out and executes no PR code. Generated suites and reviews are uploaded as
   `aq-generated-tests`, bound to the analyzed head commit.
2. **checks** checks out that exact head, installs app dependencies with scripts
   disabled, downloads the suites, and executes tests without AI keys or write
   permissions. Results and coverage are uploaded as `quality-gate-results`.
3. **report** checks out no PR code. It downloads the original generation artifact
   and result artifact, publishes reports, and saves generated test files to the
   same PR branch using GitHub APIs. `persist_tests: true` enables this behavior.

The report job needs `contents: write`, `pull-requests: write`, and `checks: write`.
Organization/repository policies or branch protections can deny these operations;
failures are reported, never bypassed. There is no direct push to the default branch,
no automatic merge, no force-push, and no writes to fork repositories. The event head
must still match the latest open PR head before files can be saved. A racing normal
branch update causes the non-fast-forward ref update to fail.

## What reviewers see

- JavaScript: `Test/quality-gate/<source-path-hash>.test.js`
- AngularJS: `quality-gate/generated.test.cjs`

These files appear under **Files changed** in the original code PR. Failing suites
are retained for review too. Merging the PR retains the tests on the base branch.
The generated namespace is managed by the Action; put independently maintained tests
outside it. A file without the generated ownership marker is never overwritten.

An identical generated suite does not create another commit. The workflow excludes
GitHub Actions bot events to prevent generation loops. After saving files, the Action
publishes a **Quality Gate** check on the new head, describing the original analyzed
source and its result; do not rely on a new workflow run being triggered by a bot
commit. Configure branch rules against this check if merge blocking is wanted.

## Running saved suites again

JavaScript uses the project's npm/Jest setup, including its existing configuration:

```text
npm ci
npx jest --coverage
```

AngularJS installations include a separate, pinned tool package in `quality-gate/`.
It preserves app dependencies and scripts. After tests have been generated:

```text
npm ci
npm ci --prefix quality-gate
node quality-gate/run.cjs
```

The helper loads the application's AngularJS package from the project root, discovers
`src/**/*.js` in bootstrap order, and instruments application source before evaluating
it in jsdom. Istanbul measures statements, branches, functions and lines. Unexecuted
source is included at 0%. `config_cov.json` sets a global statements threshold and
optional per-file statements thresholds. Low coverage fails the coverage check even
when all tests pass. Failed tests remain failed even with 100% coverage. Missing
coverage evidence is unavailable, never a pass. No assertions or app source are
rewritten to obtain a passing result.

Reports are saved under `coverage/quality-gate/`: `coverage-summary.json`, `lcov.info`,
`index.html` and `result.json`. The workflow artifact includes these files. SonarCloud
is optional for both JavaScript and AngularJS. Enable it in the UI and merge the
updated installation PR. A separate `sonar` job consumes LCOV without running PR
tests or installing dependencies. The report waits for that job and verifies its
scanner task/analysis ID; failed or unavailable scans do not become a pass. Test
evidence and persistence remain available even when SonarCloud fails.

## Maintainer verification

```text
npm ci
npm run test:setup
npm run test:pipeline
npm run test:angularjs
npm run test:ai
npm run build
```

Pipeline tests use real Jest and an AngularJS/jsdom fixture to exercise complete and
partial coverage, failing assertions, unexecuted files and rerunning committed tests.
GitHub mutations are mocked, including stale heads, default branches, forks, ownership
checks, non-fast-forward races and no-op reruns. Validate login, API permissions,
actual AI generation and publication in a disposable GitHub repository before rollout.
GitHub executes committed `dist/index.js`; publish source and bundle together and pin
all three jobs to that same commit. Old installed workflows are unchanged until the
consumer merges an update PR.
