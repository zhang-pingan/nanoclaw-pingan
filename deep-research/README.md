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

Agent integration options:

```bash
ICARUS_INTERNAL_API_HOST=127.0.0.1
ICARUS_INTERNAL_API_PORT=3004
ICARUS_INTERNAL_API_TOKEN=...
ICARUS_DEEP_RESEARCH_AGENT_CHAT_JID=web:deep-research-analyst
```

The fixed `deep-research/.data/agent-readable` directory is exported as
a sanitized, read-only view for Icarus containers. Icarus mounts it through the
Deep Research analyst group's `additionalMounts` entry at
`/workspace/extra/deep-research`, so the host path must be allowed by
`~/.config/icarus/mount-allowlist.json`. Old v1 `tasks.json` data is not
migrated; the app resets it to an empty v2 conversation store on startup.
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
