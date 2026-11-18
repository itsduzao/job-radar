# Gupy LLM Extraction — Dependency Map

## Ticket Graph

```
00-prompt-fixture ──► 01-gemini-extractor ──► 02-scraper-integration ──► 05-hardening-observability ──► 06-rollout-e2e
                                                        ▲                                                     ▲
03-config-flags ────────────────────────────────────────┘                                                     │
        │                                                                                                     │
        └──► 04-adr-docs ────────────────────────────────────────────────────────────────────────────────────────┘
```

## Execution Waves (frontier)

**Wave 1 (disjoint files, parallel):**
- 00-prompt-fixture
- 03-config-flags

**Wave 2 (após 00):**
- 01-gemini-extractor

**Wave 3 (após 01 + 03):**
- 02-scraper-integration
- 04-adr-docs (após 03; docs-only, safe beside 02)

**Wave 4 (após 02):**
- 05-hardening-observability

**Wave 5 (após 04 + 05):**
- 06-rollout-e2e

## Single-writer rule

A ticket edits only its owned files. Two tickets never edit the same file in the same wave. `src/main.ts` is written by 03 before 02; `docs/operations.md` and `.env.example` are append-only per ticket (03 → 04 → 06).

| Ticket | Owns |
|---|---|
| 00 | `src/prompts/gupy-extraction-v1.txt`, new files under `test/fixtures/gupy/` |
| 01 | `src/gemini-extractor.ts`, `test/gemini-extractor.test.ts` |
| 02 | `src/playwright-scraper.ts`, `src/main.ts`, `test/playwright-scraper-llm.test.ts` |
| 03 | `src/config.ts`, `test/config-llm.test.ts`, `docs/operations.md`, `.env.example` |
| 04 | `docs/adr/0004-gupy-llm-html-extraction.md`, `GLOSSARY.md`, `README.md`, `docs/operations.md` |
| 05 | `src/gemini-extractor.ts`, `test/gemini-extractor-hardening.test.ts` |
| 06 | `src/playwright-scraper.ts`, `src/main.ts`, `test/gupy-llm-e2e.test.ts`, `docs/operations.md`, `.env.example` |

## Notes for Chief of Staff

- 00 is the **absolute prerequisite**: no HTML real + prompt, and 01/02 are built on guesses.
- 03 is independent and parallel with 00.
- 02 is blocked by 03 because both write `src/main.ts`; serializing removes the only expected merge conflict.
- 05 hardens what 01 + 02 built; both must be merged first.
- 06 is the acceptance gate: offline E2E + shadow-mode runbook.
- All subagents use `tdd` (fixtures exist before tests); `npm test` + `typecheck` green per ticket.
- Cost target: <$0.01 per run with batch=10 on `gemini-1.5-flash`.

## Definition of Done (feature completa)

1. `GUPY_USE_LLM_EXTRACTION=true` produces `Post[]` structurally identical to the selector path (ids `gupy:{id}`, canonical urls, enriched `texto`).
2. `GUPY_LLM_SHADOW=true` logs divergences without changing production output.
3. `npm test` (offline) + `npm run typecheck` green.
4. ADR-0004 + operations.md + `.env.example` updated.
