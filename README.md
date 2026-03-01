# bft-api

API for **Built for Tomorrow** – guided interview platform for students and young adults (sessions, assessments, reports).

## Setup

```bash
npm install
cp env.example .env
# Edit .env if needed (PORT, CORS_ORIGIN)
```

## Run

- **Production:** `npm start`
- **Development (watch):** `npm run dev`

The API listens on **port 3001** by default so it doesn't conflict with the UI dev server on port 3000. Set `PORT` in `.env` to change it.

## API base

Routes are mounted under `/api`:

- **Sessions:** `POST /api/sessions`, `GET /api/sessions/:id`, `PATCH /api/sessions/:id`
- **Assessments:** `POST /api/sessions/:sessionId/answers`, `GET /api/sessions/:sessionId/assessment`
- **Reports:** `GET /api/sessions/:sessionId/report`

## LLM (assess answers & generate next questions)

The API uses a **unified LLM config** (aligned with the Python project): provider, prompt files, generation params. Secrets (API keys) go in `.env` only.

- **Config:** `config/llm.js` — provider, base URL, model, temperature, max_tokens, top_p, request delay, prompt file paths.
- **Prompt files:** `conf/` (paths relative to project root). Default system prompt: `conf/assessment_system_prompt.txt`. Override with `LLM_SYSTEM_PROMPT_FILE`.
- **Providers:** `ollama` (local/remote Ollama), `ollama_cloud` (Ollama Cloud + optional web search).
- **Env:** See `env.example`. Set `LLM_PROVIDER`, `OLLAMA_API_KEY` (for cloud), `LLM_MODEL`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TOP_P`, `LLM_SYSTEM_PROMPT_FILE`. Never commit API keys.

When the LLM is enabled (Ollama or Ollama Cloud), `GET .../assessment/next` uses it to generate the next question; on failure or if disabled, the API falls back to static questions.

## Structure

- `server.js` – entry point
- `app.js` – Express app, middleware, routes
- `config/` – env-based config (`index.js`, `llm.js`, `ollama.js` for backward compat)
- `conf/` – prompt files (e.g. `assessment_system_prompt.txt`)
- `src/routes` – route definitions
- `src/controllers` – request/response handling
- `src/services` – business logic (in-memory; Ollama for interview flow)
- `src/middleware` – error handling, not found
- `src/lib` – shared helpers, Ollama client, interview prompts
