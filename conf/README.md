# LLM configuration and prompts

Paths here are relative to the bft-api project root. Referenced from `config/llm.js` via env (e.g. `LLM_SYSTEM_PROMPT_FILE=conf/assessment_system_prompt.txt`).

- **assessment_system_prompt.txt** – System prompt for the interview (assess answers, generate next question as JSON).
- Optional: **handoff** or **web_search** suffix files can be added and wired via `LLM_HANDOFF_SYSTEM_PROMPT_FILE` / similar.
- **report_profile_system_prompt.txt** – System prompt for report profile summary (LLM synthesis: full narrative from Q&A). Wired via `LLM_REPORT_PROFILE_SYSTEM_PROMPT_FILE`.
- **report_hybrid_system_prompt.txt** – System prompt for report hybrid summary (short narrative from explored dimensions). Wired via `LLM_REPORT_HYBRID_SYSTEM_PROMPT_FILE`.
- **report_recommendations_system_prompt.txt** – System prompt for profession/career recommendations (recommended directions with fit, directions to avoid). Optional; wired via `LLM_REPORT_RECOMMENDATIONS_SYSTEM_PROMPT_FILE`. When set, the report includes career cluster alignment and “directions to avoid” in the results.

# Assessment model: aptitudes, traits, values, skills (interview + recommendations)

Assessment data files live in **src/data/** (not in conf/):

- **src/data/aptitudes.json** – Aptitudes: natural affinity and raw potential (e.g. technical_hands_on, creative_open_ended). Largely stable; dictate ceiling and speed of learning.
- **src/data/traits.json** – Traits: personality and behavioral tendencies (e.g. experimentation_risk_tolerance, social_collaboration, ambiguity_resilience). How you behave; stable “handling” that shapes fit for environments.
- **src/data/values.json** – Values: non-negotiables and destination (e.g. helping_others_impact, mastery_growth, autonomy_independence). The fuel that keeps you going; used for career cluster and mission fit.
- **src/data/skills.json** – Skills: trainable capabilities and learned techniques. Includes former foundational_literacy (instruction_clarity, ai_literacy) and cognitive capabilities (e.g. problem_formulation, systems_thinking, epistemic_calibration). Developed by applying practice to aptitudes and traits.

Each file has version, sources, description, and an array of items with id, name, description, how_measured_or_observed, question_hints. Used by the API to generate interview questions and drive assessment. Sources: Citrini 2028 GIC, Microsoft New Future of Work Report 2025.

- **src/data/ai_relevance_ranking.json** – Ranking of each item by relevance in the AI era (trend: increasing/stable/decreasing/mixed; relevance_score 0–1). Used by the API for recommendations: career clusters, skill stacks, resilient paths. `trait_id` refers to an id in the corresponding file in **src/data/**.

Secrets (e.g. `OLLAMA_API_KEY`) are set in `.env`, not in this folder.
