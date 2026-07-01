# Deep Research Web

Standalone web app for running Deep Research conversations.

## Run

```bash
cd deep-research
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm start
```

Optional:

```bash
PORT=8787 DEEP_RESEARCH_DEFAULT_MODEL=o3-deep-research npm start
```

Open `http://localhost:8787`.

The UI is conversation-based:

- normal input creates a new research report task in the current conversation
- `@agent ...` routes the message to the Icarus Deep Research analyst agent
- report cards can be referenced before sending `@agent`

Runtime configuration is loaded from `deep-research/.env`.
Shell environment variables override values in `.env`.

Provider-related options:

```bash
DEFAULT_RESEARCH_PROVIDER=openai
GPT_RESEARCHER_BASE_URL=http://127.0.0.1:8000
GPT_RESEARCHER_REPORT_TYPE=research_report
GPT_RESEARCHER_REPORT_SOURCE=web
GPT_RESEARCHER_TONE=Objective
```

When the UI provider is `GPT Researcher API`, this app calls
`$GPT_RESEARCHER_BASE_URL/report/` and stores the returned report in the same
viewer/export flow.

## GPT Researcher service

The local GPT Researcher service is checked out at:

```bash
/Users/chelaile/IdeaProjects/gpt-researcher
```

Start or refresh the service with Docker Compose:

```bash
cd /Users/chelaile/IdeaProjects/gpt-researcher
docker compose up -d gpt-researcher gptr-nextjs
docker compose ps
```

Compose services used by this app:

| Service | Container | Image | Local URL | Purpose |
| --- | --- | --- | --- | --- |
| `gpt-researcher` | `gpt-researcher-gpt-researcher-1` | `gptresearcher/gpt-researcher` | `http://127.0.0.1:8000` | FastAPI backend used by `GPT_RESEARCHER_BASE_URL`; runs `uvicorn main:app --host ${HOST} --port ${PORT} --workers ${WORKERS}`. |
| `gptr-nextjs` | `gpt-researcher-gptr-nextjs-1` | `gptresearcher/gptr-nextjs` | `http://127.0.0.1:3010` | GPT Researcher Next.js UI; optional for this app, useful for direct debugging. |

Current observed container status on 2026-06-30:

```text
gpt-researcher-gpt-researcher-1  gptresearcher/gpt-researcher  0.0.0.0:8000->8000/tcp  Up 27 hours
gpt-researcher-gptr-nextjs-1     gptresearcher/gptr-nextjs     0.0.0.0:3010->3010/tcp  Up 6 hours
```

The backend Compose service reads `/Users/chelaile/IdeaProjects/gpt-researcher/.env`
and mounts these host directories into the container:

```text
my-docs  -> /usr/src/app/my-docs
outputs  -> /usr/src/app/outputs
logs     -> /usr/src/app/logs
```

For Deep Research integration, keep `deep-research/.env` pointed at the backend:

```bash
DEFAULT_RESEARCH_PROVIDER=gpt-researcher
GPT_RESEARCHER_BASE_URL=http://127.0.0.1:8000
```

The GPT Researcher Next.js UI defaults to `http://localhost:8000` when
`NEXT_PUBLIC_GPTR_API_URL` is not set.

Agent integration options:

```bash
ICARUS_INTERNAL_API_HOST=127.0.0.1
ICARUS_INTERNAL_API_PORT=3004
ICARUS_INTERNAL_API_TOKEN=...
ICARUS_DEEP_RESEARCH_AGENT_CHAT_JID=web:deep-research-analyst
GPT_RESEARCHER_PROMPT_ENRICHMENT_ENABLED=true
```

When GPT Researcher tasks run, Deep Research first asks the Icarus agent to
inspect the original prompt and optionally add direct-API or local structured
data. The agent is instructed not to use web search for this step. Deep Research
then validates the returned JSON template, verifies that `original_prompt` is
unchanged, rejects search/browser/Tavily sources, and submits the validated
effective prompt to GPT Researcher. Set
`GPT_RESEARCHER_PROMPT_ENRICHMENT_ENABLED=false` to bypass this pre-step.

The fixed `deep-research/.data/agent-readable` directory is exported as
a sanitized, read-only view for Icarus containers. Icarus mounts it through the
Deep Research analyst group's `additionalMounts` entry at
`/workspace/extra/deep-research`, so the host path must be allowed by
`~/.config/icarus/mount-allowlist.json`. Internal state is stored under
`deep-research/.data/store` as a v3 directory store split by conversation.
Legacy `deep-research/.data/tasks.json` data is not migrated; it is removed and
the app starts with an empty v3 store.
Within the mounted view, each conversation has a single directory:
`{conversation_id}/session.json` plus `{task_id}.json` metadata files. A
`{task_id}.md` report file is exported only after the task completes with report
content.

## Local scripts

The repo also includes local shell wrappers:

```bash
local/shell/deep-research/start.sh
local/shell/deep-research/stop.sh
local/shell/deep-research/restart.sh
```

Optional environment variables:

```bash
PORT=8788 HOST=127.0.0.1 local/shell/deep-research/start.sh
```

The local scripts also read `deep-research/.env` before starting or
stopping the service.

## Notes

- API keys stay server-side. The browser only calls this local app.
- Deep Research runs through the Responses API with `background: true`.
- The app uses `web_search_preview` as the default data source.
- The "PDF" export matches the existing Icarus printable-export style: it opens a print-ready HTML document so the browser can save it as PDF.
