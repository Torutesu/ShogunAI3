<wizard-report>
# PostHog post-wizard report

The wizard has completed a deep integration of PostHog analytics into the `hifi/amc-pipeline` Node.js package. A new shared PostHog client (`src/posthog.js`) was added using `posthog-node` with CLI-appropriate settings (`flushAt: 1`, `flushInterval: 0`). Environment variables `POSTHOG_API_KEY` and `POSTHOG_HOST` were written to `hifi/amc-pipeline/.env`. Events were instrumented across three files: the CLI entry point, the pipeline orchestrator, and the AI composer.

| Event | Description | File |
|---|---|---|
| `brief_pipeline_started` | Fired when the CLI is invoked, capturing dry-run and validate-only mode | `hifi/amc-pipeline/src/cli.js` |
| `brief_pipeline_completed` | Fired on successful pipeline completion with item and deferred counts | `hifi/amc-pipeline/src/cli.js` |
| `brief_pipeline_failed` | Exception captured via `captureException` when the CLI process throws | `hifi/amc-pipeline/src/cli.js` |
| `brief_pipeline_skipped` | Fired when the orchestrator exits early due to no candidates | `hifi/amc-pipeline/src/orchestrator.js` |
| `brief_composer_error` | Fired when a single candidate composition fails and the heuristic fallback is used | `hifi/amc-pipeline/src/orchestrator.js` |
| `brief_summary_generated` | Fired after ranked items and headline summary are produced | `hifi/amc-pipeline/src/orchestrator.js` |
| `brief_composer_fallback_used` | Fired when the primary model is rate-limited (429/529) and retries with the fallback | `hifi/amc-pipeline/src/composer.js` |

## Next steps

We've built some insights and a dashboard for you to keep an eye on pipeline health, based on the events we just instrumented:

- **Dashboard — Analytics basics**: https://us.posthog.com/project/392488/dashboard/1501109
- **Pipeline runs over time**: https://us.posthog.com/project/392488/insights/8DGkXVby
- **Pipeline success vs failure** (funnel): https://us.posthog.com/project/392488/insights/yVs6an7N
- **Composer errors over time**: https://us.posthog.com/project/392488/insights/xsovDbF3
- **Fallback model usage**: https://us.posthog.com/project/392488/insights/vK2XdKzN
- **Pipeline skips (no candidates)**: https://us.posthog.com/project/392488/insights/TzioMnxS

### Agent skill

We've left an agent skill folder in your project. You can use this context for further agent development when using Claude Code. This will help ensure the model provides the most up-to-date approaches for integrating PostHog.

</wizard-report>
