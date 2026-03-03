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

## Assessment model (interview + recommendations)

The interview is designed to (a) identify **aptitudes** and **traits** (intrinsic, hard to change), (b) identify **values** and **interests** (driving force), (c) advise on **skills** to develop or already present, and (d) recommend profession or study direction using all of the above.

Assessment data lives in **`src/data/`** (not in `conf/`):

- **aptitudes.json** – Natural affinity and raw potential (e.g. logical_analytical_reasoning, verbal_linguistic, technical_hands_on, creative_open_ended). Used to infer ceiling and learning speed.
- **traits.json** – Personality and behavioral tendencies (e.g. experimentation_risk_tolerance, social_collaboration, ambiguity_resilience). How the user behaves.
- **values.json** – Non-negotiables and destination (e.g. helping_others_impact, mastery_growth, autonomy_independence). Used for career cluster and mission fit.
- **skills.json** – Trainable capabilities (e.g. problem_formulation, instruction_clarity, delegation_oversight). Used to advise what to develop and to assess current level.
- **ai_relevance_ranking.json** – Per-item relevance in the AI era (trend, score, rationale). Used for recommendations (career clusters, skill stacks, resilient paths). `trait_id` refers to an id in one of the four files above.

Each data file has version, sources, description, and items with id, name, description, how_measured_or_observed, question_hints. Sources: Citrini 2028 GIC, Microsoft New Future of Work Report 2025. See **`conf/README.md`** for LLM prompts and config.

## Scripts

### NOC enrichment (preparation)

**`src/scripts/enrich-noc-with-mappings.js`** – Enriches each NOC 2021 occupation with LLM-generated mappings to skills, traits, and values (high compatibility only, rating 1–5). Validates IDs against `src/data/skills.json`, `traits.json`, and `values.json`; on invalid IDs sends one correction request to the LLM. Writes `data/noc-2021-enriched.json` (or paths from env/CLI).

Run from project root:

```bash
node src/scripts/enrich-noc-with-mappings.js [--debug] [--input path] [--output path] [--limit N]
```

If the output file already exists, occupations already present (by `nocCode`) are skipped (resume). Use `--limit N` or `NOC_ENRICHMENT_LIMIT` to process only the first N occupations and exit (e.g. for testing).

Uses the same LLM `.env` vars as the API (`LLM_PROVIDER`, `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` for cloud, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `LLM_TOP_P`). Optional: `NOC_JSON_INPUT`, `NOC_JSON_OUTPUT`, `NOC_ENRICHMENT_SYSTEM_PROMPT_FILE`, `DEBUG=1` to print LLM prompt and response. See `env.example`.

## Structure

- `server.js` – entry point
- `app.js` – Express app, middleware, routes
- `config/` – env-based config (`index.js`, `llm.js`, `ollama.js` for backward compat)
- `conf/` – LLM prompt files (e.g. `assessment_system_prompt.txt`), `personality_clusters.json`. See `conf/README.md`. Assessment model data is in `src/data/`.
- `src/data/` – assessment model JSON (aptitudes, traits, values, skills, ai_relevance_ranking)
- `src/routes` – route definitions
- `src/controllers` – request/response handling
- `src/services` – business logic (in-memory; Ollama for interview flow)
- `src/middleware` – error handling, not found
- `src/lib` – shared helpers, Ollama client, interview prompts
