# AngularJS 1.x support

The existing `generate-tests.js` action entry point now supports AngularJS projects
that use `node --test` with jsdom. `project_type: auto` detects the `angular`
dependency; set `project_type: angularjs` explicitly in a report job with no checkout.
JavaScript/Jest projects retain the existing generation path.

AngularJS checks run the consumer's `npm run check` and `npm test`, capture TAP
counts and output, and reuse the original npm audit implementation. AI review
reuses the original Gemini classifier with AngularJS context. PR comments reuse
the original comment publisher, now updating one bot comment and writing an Actions
summary. The report identifies this repository as the engine.

## Two isolated jobs

1. On a read-only runner without secrets, checkout the PR head with
   `persist-credentials: false`, install with `npm ci --ignore-scripts`, then use
   this action with `project_type: angularjs`, `phase: checks`, and
   `install_status: ${{ steps.install.outcome }}`. Upload `.gate-state.json` with
   `actions/upload-artifact@v4` and `include-hidden-files: true`.
2. Run a separate `if: always()` report job with `contents: read` and
   `pull-requests: write`. Download that artifact to the workspace. Do not checkout
   or execute PR code. Use this action with `project_type: angularjs`, `phase: report`,
   `report_only: true`, `github_token` and `gemini_api_key` from secrets.

Pin both uses of the action to the same reviewed commit. The report job reads
source at the PR head through GitHub APIs, validates the artifact's commit, and
reports unavailable checks if the artifact is missing. `pull_request_target` is
supported for fork PR comments only with this job isolation. Source is sent to
Gemini; files/diffs are bounded and omitted files are listed. AI text is never executed.

`gemini_model` and `ai_timeout_seconds` are configurable. Missing keys, API errors,
timeouts and malformed responses appear as skipped/unavailable, never clean.
`report_only: true` keeps findings informational; report delivery failures still
fail the action. Without it, failed/incomplete AngularJS reports fail the action.

AngularJS AI-generated tests, coverage enforcement and SonarCloud are explicitly
deferred in this first adapter. The existing application tests are run, not replaced.
The install check reports the outcome supplied by the calling workflow.
Run adapter regression tests with `npm run test:angularjs`, then `npm run build`
to update `dist/index.js`, which GitHub executes.
