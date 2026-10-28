# AI outages and incomplete reports

The Action uses only the model selected by the user. HTTP 429 and 5xx responses
receive one retry after approximately 1–2 seconds (two attempts total). It never
switches models or providers. Other errors are reported without additional retries.

AI requests have no Action-defined timeout or shared retry deadline. A pending
request waits for a response until canceled or ended by the provider/platform.
The generated `generate` job omits a custom `timeout-minutes` value and uses
GitHub Actions limits. Test execution, scanning and reporting keep their separate
limits. This does not promise an unlimited GitHub Actions run.

Legacy inputs `ai_timeout_seconds` and `ai_fallback_models` are accepted but ignored
for compatibility with older workflow files. The web installer emits neither input
and no longer reads the `AI_FALLBACK_MODELS` repository variable.

Unavailable AI remains an incomplete check after both attempts fail. It is never
reported as a clean review. Coverage without actual test execution and measurement
is shown as unavailable; measured coverage below its threshold still fails.
Sonar scan errors remain distinct from a failed Sonar quality gate. Scanner
metadata uses an absolute `${{ github.workspace }}/.scannerwork/report-task.txt`
path in current generated workflows.

Existing installations must update the pinned Action and workflow to use these
changes; rerunning an old pinned version keeps its old timeout/retry behavior.
