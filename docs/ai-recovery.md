# AI outages and incomplete reports

The Action retries transient service, quota/rate-limit, timeout and connection failures twice per model with a delay. Authentication, permission, invalid configuration and missing models fail immediately.

`ai_timeout_seconds` is the total time budget for each logical AI request, including retries and fallback models. The available request time is divided across remaining attempts so one stalled primary request does not consume the entire fallback budget.

Set optional `ai_fallback_models` to up to two comma-separated model IDs available to the same provider and API key. The web installer forwards the repository Actions variable `AI_FALLBACK_MODELS` to this input. An empty variable uses only the selected primary model. Model access must be configured by the repository owner; the Action does not switch providers or credentials. Workflow logs identify fallback use.

Unavailable AI remains an incomplete check after all attempts fail. It is never reported as a clean review. Coverage without actual test execution and measurement is shown as unavailable; measured coverage below its threshold still fails. Sonar scan errors remain distinct from a failed Sonar quality gate.
