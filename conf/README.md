# LLM configuration and prompts

Paths here are relative to the bft-api project root. Referenced from `config/llm.js` via env (e.g. `LLM_SYSTEM_PROMPT_FILE=conf/assessment_system_prompt.txt`).

- **assessment_system_prompt.txt** – System prompt for the interview (assess answers, generate next question as JSON).
- Optional: **handoff** or **web_search** suffix files can be added and wired via `LLM_HANDOFF_SYSTEM_PROMPT_FILE` / similar.

# Trait/skill model and AI relevance (interview + recommendations)

- **traits_skills_model.json** – Model of traits and skills (aptitudes, behavioral tendencies, skills) with id, name, description, how measured/observed, and question hints. Used by the API to generate interview questions and drive assessment. Sources: Citrini 2028 GIC, Microsoft New Future of Work Report 2025.
- **ai_relevance_ranking.json** – Ranking of each trait/skill by relevance in the AI era (trend: increasing/stable/decreasing/mixed; relevance_score 0–1). Used by the API for recommendations: career clusters, skill stacks, resilient paths. `trait_id` matches `traits_skills_model.json`.

Secrets (e.g. `OLLAMA_API_KEY`) are set in `.env`, not in this folder.
