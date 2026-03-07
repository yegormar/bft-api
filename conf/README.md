# LLM configuration and prompts

Paths here are relative to the bft-api project root. Referenced from `config/llm.js` via env.

**Active prompts (required where noted):**
- **scenario_step1.txt** (Step 1), **scenario_step2_critique.txt**, **scenario_step2_judge.txt** (Step 2), **scenario_step3.txt** (Step 3). Three-step scenario generation: Step 1 creative; Step 2 critique then judge (two LLM calls); Step 3 format and score. Required: `BFT_SCENARIO_STEP1_INSTRUCTIONS_FILE`, `BFT_SCENARIO_STEP3_INSTRUCTIONS_FILE`. Step 2 prompts loaded from conf/ when present (fallback to in-code). Step 3: placeholders in judge file `{{CRITIQUE_SENTENCE}}`, `{{DIMENSION_NAME}}`.
- **report_profile_system_prompt.txt** – System prompt for report profile summary (LLM synthesis: full narrative from Q&A). Required; wired via `LLM_REPORT_PROFILE_SYSTEM_PROMPT_FILE`. Process exits if unset or file missing.
- **report_hybrid_system_prompt.txt** – System prompt for report hybrid summary (short narrative from explored dimensions). Required; wired via `LLM_REPORT_HYBRID_SYSTEM_PROMPT_FILE`. Process exits if unset or file missing.
- **report_recommendations_system_prompt.txt** – System prompt for profession/career recommendations (recommended directions with fit, directions to avoid). Required; wired via `LLM_REPORT_RECOMMENDATIONS_SYSTEM_PROMPT_FILE`. Process exits if unset or file missing.

- **conf/legacy/** – Unused/legacy prompt files. Not used by the current flow: assessment_system_prompt.txt (only used by assessAndGetNextQuestion, which is never called), scenario_design_instructions.txt (only read by getScenarioSystemPrompt, which is never called), scenario_step1_instructions.txt, scenario_step2_instructions.txt. Kept for reference.

# Assessment model: aptitudes, traits, values, skills (interview + recommendations)

Assessment data files live in **src/data/** (not in conf/):

- **src/data/aptitudes.json** – Aptitudes: natural affinity and raw potential (e.g. technical_hands_on, creative_open_ended). Largely stable; dictate ceiling and speed of learning.
- **src/data/traits.json** – Traits: personality and behavioral tendencies (e.g. experimentation_risk_tolerance, social_collaboration, ambiguity_resilience). How you behave; stable “handling” that shapes fit for environments.
- **src/data/values.json** – Values: non-negotiables and destination (e.g. helping_others_impact, mastery_growth, autonomy_independence). The fuel that keeps you going; used for career cluster and mission fit.
- **src/data/skills.json** – Skills: trainable capabilities and learned techniques. Includes former foundational_literacy (instruction_clarity, ai_literacy) and cognitive capabilities (e.g. problem_formulation, systems_thinking, epistemic_calibration). Developed by applying practice to aptitudes and traits.

Each file has version, sources, description, and an array of items with id, name, description, how_measured_or_observed, question_hints. Used by the API to generate interview questions and drive assessment. Sources: Citrini 2028 GIC, Microsoft New Future of Work Report 2025.

- **src/data/ai_relevance_ranking.json** – Ranking of each item by relevance in the AI era (trend: increasing/stable/decreasing/mixed; relevance_score 0–1). Used by the API for recommendations: career clusters, skill stacks, resilient paths. `trait_id` refers to an id in the corresponding file in **src/data/**.
- **src/data/scenarioBatches.json** – Offline-prepared batches of traits and values (2–3 dimensions per batch) for scenario questions. Interview selects from these batches so total questions stay ≤ 20; dimensions may overlap across batches. Each batch has optional preferredResponseType (single_choice, multi_choice, rank), theme label, and dilemmaAnchor (a situation-only one-line hint for step 1; when present, the generator uses it instead of dimension names or theme so the scenario stays indirect).

Secrets (e.g. `OLLAMA_API_KEY`) are set in `.env`, not in this folder.
