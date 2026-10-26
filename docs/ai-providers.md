# User-defined AI models

> For current installation, test persistence and AngularJS coverage behavior, see
> [reviewable tests](reviewable-tests.md). The historical AngularJS coverage/report-only notes below describe the preceding workflow.

The default remains the native Gemini API. There is no model allowlist. Other services
can be used if they implement the OpenAI-compatible **Chat Completions** request and
response format. This does not implement Anthropic Messages, OpenAI Responses, custom
authentication headers, local servers, or arbitrary API protocols.

## Inputs

| Input | Meaning |
| --- | --- |
| `ai_provider` | `gemini` (default) or `openai-compatible`; selects a protocol, not a company/model |
| `ai_model` | Arbitrary model ID. Overrides the legacy `gemini_model` input |
| `ai_api_url` | Complete public HTTPS Chat Completions endpoint, including its path |
| `ai_api_key` | Repository secret for the compatible endpoint |
| `gemini_api_key` | Existing Gemini secret; unchanged for native Gemini |
| `ai_timeout_seconds` | 10–180 seconds per attempt; at most two attempts for 429/5xx |

Example inputs for a caller workflow (pin `uses` to the published commit of this
Action, including its rebuilt `dist/index.js`):

```yaml
with:
  project_type: javascript
  ai_provider: openai-compatible
  ai_api_url: https://your-provider.example/v1/chat/completions
  ai_model: your-model-id
  ai_api_key: ${{ secrets.AI_API_KEY }}
  github_token: ${{ github.token }}
  ai_timeout_seconds: '90'
```

For AngularJS, preserve the generate/checks/report job isolation in `angularjs.md`.
Only generate receives the AI secret. Pass provider, URL and model to generate/report;
checks receives no AI credentials and continues to run on a read-only runner. All
three phases must reference the same Action commit. Tests are still owned by the
Action; coverage/SonarCloud remain deferred for AngularJS.

## Failure behavior

No automatic provider/model fallback. Missing or invalid keys, inaccessible models,
quota limits, timeouts, unsupported responses, truncated output and malformed review
JSON become unavailable AI results. JavaScript cannot finish successfully after an AI
request/output failure. AngularJS preserves its existing `report_only` behavior: a
green job with `report_only: true` is not evidence of passing quality checks; read the
PR comments for FAIL/INCOMPLETE results.

HTTP errors are reported with safe categories, without copying upstream response
bodies, credentials or URLs into errors. API keys are masked in Actions logs and
removed from model text if reflected. The compatible request includes only `model`
and a user `messages` array, expecting `choices[0].message.content` as text.

HTTPS certificate validation remains enabled. Credentials/query/fragment in URLs,
redirects, private/reserved IPs and DNS results containing private addresses are
rejected. Connections use the validated DNS addresses. Request/response text is
bounded (2 MiB for compatible requests/responses); this is not a token spending cap.
The user chooses the destination that receives repository code and their API key.

## Validation and publication

```text
npm run test:ai
npm run test:angularjs
npm run build
```

Unit/transport mocks and an actual Action entry-point missing-key scenario cover
failure handling without spending API credits. Validate a real model/key and GitHub
PR in a disposable consumer repository before wider rollout. Commit both source and
dist; GitHub runs the committed bundle, not local source. The UI checks that its
pinned compatible Action commit is available on GitHub before creating install PRs.

Protocol reference: https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create
