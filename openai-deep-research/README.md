# OpenAI Deep Research Web

Standalone web app for running OpenAI Deep Research tasks.

## Run

```bash
cd openai-deep-research
cp .env.example .env
# edit .env and set OPENAI_API_KEY
npm start
```

Optional:

```bash
PORT=8787 OPENAI_DEEP_RESEARCH_DEFAULT_MODEL=o3-deep-research npm start
```

Open `http://localhost:8787`.

Runtime configuration is loaded from `openai-deep-research/.env`.
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

## Local scripts

The repo also includes local shell wrappers:

```bash
local/shell/openai-deep-research/start.sh
local/shell/openai-deep-research/stop.sh
local/shell/openai-deep-research/restart.sh
```

Optional environment variables:

```bash
PORT=8788 HOST=127.0.0.1 local/shell/openai-deep-research/start.sh
```

The local scripts also read `openai-deep-research/.env` before starting or
stopping the service.

## Notes

- API keys stay server-side. The browser only calls this local app.
- Deep Research runs through the Responses API with `background: true`.
- The app uses `web_search_preview` as the default data source.
- The "PDF" export matches the existing Icarus printable-export style: it opens a print-ready HTML document so the browser can save it as PDF.
