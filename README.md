# AI-Suggestions

Independent multi-agent service for the Automated Code Review and Technical Debt Analysis Dashboard. Development belongs on `development`; UI changes belong on `web-interface/Janu-development`. The analysis-engine-service is an unchanged upstream producer, not part of this service.

## Implemented flow

1. The signed-in dashboard user selects an analysed PR and its commit.
2. The deterministic ContextLoader reads PR metadata/source through a GitHub App and reads both PostgreSQL databases directly with read-only sessions.
3. ReviewAgent uses one model call to classify findings, add technical-debt context, prioritize them, and produce schema-validated explanations and suggested corrections.
4. FixAgent uses a second model call to generate exact line replacements for selected findings. The service checks the scope and original text, and generates the unified diff itself.
5. DeliveryAgent uses deterministic code to validate Git patch application in an immutable Docker image without network access, service credentials, or a Docker socket. The patch is mounted read-only; the runner works in temporary storage.
6. After validation, DeliveryAgent creates a deterministic `ai-fixes/<original-pr>/<job-id>` branch and a separate fix PR **targeting the original PR's source branch**. This keeps the fix PR focused on the selected changes. It never pushes to the original branch. Main, master and the default branch cannot be fix targets.
7. A project manager or administrator may explicitly confirm a merge from AI Code Fixing. The service checks source/fix commit identities and delegates the merge to GitHub, which enforces the App's permissions and branch protection. Configure the App without protection bypass rights. There is no automatic merging.

### Agent design

The workflow has three agents: ReviewAgent, FixAgent and DeliveryAgent. Only the first two call the AI provider, so a fix job normally uses two model requests instead of four. Data loading, schema checks, patch construction, authorization, persistence and GitHub access remain deterministic support code managed by the Jobs orchestrator. This keeps validation independent from model judgment while reducing latency, token usage and orchestration complexity.

## Setup

Requires Node.js 22.21+ (22.22.2+ recommended for the UI's jsdom), Git, Docker with Linux containers, two PostgreSQL databases, a GitHub App installation, and an OpenAI-compatible chat-completions provider. No provider-specific SDK is required.

```powershell
npm.cmd ci
Copy-Item .env.example .env
# Fill .env locally, then:
npm.cmd start
```

Never commit `.env`, private keys or `data/`. The example contains placeholders only. Missing and placeholder values cause startup failure. Keep the job directory private: it contains source snapshots, findings and patches, but no service tokens. Back it up according to your source-code retention policy.

| Configuration | Meaning |
| --- | --- |
| `ANALYSIS_DATABASE_URL` | Read-only PostgreSQL connection to analysis-engine tables |
| `TECHNICAL_DEBT_DATABASE_URL` | Read-only PostgreSQL connection to debt records |
| `DEBT_TABLE` | Actual debt table name; simple SQL identifier |
| `DEBT_REPOSITORY_COLUMN` | Column containing `owner/repository` |
| `DEBT_PR_COLUMN` | Column containing the PR number |
| `DEBT_COMMIT_COLUMN` | Column containing the exact analysed commit SHA |
| `GITHUB_API_URL` | GitHub API base URL |
| `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` | App and installation identifiers |
| `GITHUB_PRIVATE_KEY_PATH` | PEM file outside both repositories |
| `AI_PROVIDER_BASE_URL` | Provider API base, before `/chat/completions` |
| `AI_PROVIDER_API_KEY`, `AI_PROVIDER_MODEL` | Server-only provider credentials/model |
| `INTERNAL_SERVICE_TOKEN` | Random shared secret of at least 32 characters; same as Next.js server |
| `MAIN_BACKEND_URL` | Existing backend used to verify the user's bearer session and repository access |
| `VALIDATOR_IMAGE` | Administrator-built validation image, pinned as `image@sha256:<digest>` |
| `PORT` | Default 8010, bound to loopback; expose through a trusted reverse proxy when needed |
| `JOB_DIRECTORY` | Default `data/jobs`; private persistent storage |

The App needs repository contents read/write and pull requests read/write. Give database users SELECT permission only; the client additionally enables `default_transaction_read_only`. SQL values are parameterized.

## Database mapping and outstanding integration

The analysis adapter matches `analysis-engine-service/src/analysis_engine/repositories/analysis_result_repository.py`: `analysis_results` and `findings`, including `end_line`, JSONB `metadata`, metrics and change-set data. Only a completed result for the requested repository, PR and exact head commit is used.

**The technical-debt schema has not yet been supplied.** The current configurable adapter expects a PostgreSQL table with repository, PR and commit columns, and reads its matching metric records. Supply the real schema before enabling production use. If debt data uses a different database engine, joins, JSON layout or repository identifier, adapt `src/database.ts` to that verified contract; do not invent a table or substitute example metrics. Missing debt records prevent generation.

No live database/model/GitHub end-to-end verification has been performed without these credentials and settings. Existing analysis in the dashboard remains usable while AI configuration is unavailable.

## Validation image

`validator/Dockerfile` and `validator/validate.mjs` provide a starting image for JavaScript/TypeScript repositories. Build it, publish it to your registry, and configure its immutable digest. The runner parses source, runs TypeScript checking when a tsconfig exists, runs `npm run lint` (or conservative built-in JavaScript rules) and `npm test`. It never installs PR dependencies at runtime.

Projects needing dependencies must use a project-specific image containing their preinstalled dependencies and a trusted entrypoint. Other languages need a corresponding image. The entrypoint receives `/workspace` read-only and must write `/output/result.json` with exactly one `syntax`, `lint`, and `tests` check:

```json
{"checks":[{"name":"syntax","status":"passed","details":"..."},{"name":"lint","status":"passed","details":"..."},{"name":"tests","status":"passed","details":"..."}]}
```

Only `passed` checks allow publication. Missing tests, missing dependencies, unavailable Docker, failed checks and malformed reports all fail closed. Do not mount secrets or host Docker sockets in a validator. Tests run in the isolated container and must not require network access. The runner has a 180-second timeout, 512 MB memory limit, one CPU and 128-process limit.

## API

All endpoints except `/health` require `X-Internal-Token` and the user's `Authorization: Bearer ...`; browser calls go through the Next.js proxy. No service token is sent to the browser. Repository access is checked on every read and action through the existing main backend's PR analysis endpoint. Merge additionally requires an ADMIN or MANAGER membership in an organization with the active repository integration.

| Method / route | Input / behavior |
| --- | --- |
| `POST /jobs` | `{owner, repository, pullRequestNumber, headSha, selectedFindingIds}`; empty IDs generates suggestions only |
| `GET /jobs/:id` | Current public job; never returns the full private source snapshot |
| `POST /jobs/:id/retry` | Retry a failed generation without a patch |
| `POST /jobs/:id/validate` | Validate saved patch |
| `POST /jobs/:id/publish` | Create fix PR only after that exact patch passes |
| `POST /jobs/:id/merge` | `{confirm:true, commitSha}`; explicit authorized merge |

Creation returns `{job, duplicate}` and asynchronous actions return `{job}`. Poll at two-second intervals. `src/contracts.ts` defines all response fields; `web-interface/lib/aiTypes.ts` mirrors it. HTTP errors are `{error:{code,message}}`; dependency errors are sanitized.

Jobs persist atomically in a local directory. One service process is supported; a lock prevents concurrent writers. After an abnormal process exit, stop all workers before removing a stale `worker.lock`. Interrupted generation can be retried; interrupted validation must be rerun. Deterministic branches and GitHub lookups avoid duplicate PRs after uncertain publish responses. Horizontal scaling requires a transactional job store/queue before deployment.

Current bounds: same-repository PRs, 100 selected findings, 1,500 tree entries, 5 MB source snapshot, 200 KB per file, 200 KB model input, four generating jobs. Binary, symlink, executable and sensitive configuration entries are excluded from source collection. Generated changes support LF UTF-8 text and exact finding line ranges only; wider fixes require manual review. Overlapping edits fail rather than overwrite each other. A finding without a line cannot be automatically fixed.

## Checks

```powershell
npm.cmd test
npm.cmd run lint
npm.cmd run typecheck
```

Tests use local fixtures and mocked integrations; Git patch tests use the real Git executable. They do not create organization branches, commits, PRs or merges.
