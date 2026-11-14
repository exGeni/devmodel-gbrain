#!/usr/bin/env bash
# CI guard: retired contributor-workflow phrases stay out of the docs agents follow.
#
# Refactor wave 1 moved the code several always-loaded instructions pointed at:
# migrations are one file each under src/core/schema-migrations/, migrated
# storage domains keep their SQL once in src/core/engine-sql/, CLI-only
# commands are records in src/cli/command-table.ts, the PGLite schema template
# is generated, and the migrate.ts region policy is gone. Agents follow
# CLAUDE.md, AGENTS.md, CONTRIBUTING.md, docs/ and skills/ literally, so one
# stale sentence sends them to edit the wrong file. This guard fails when a
# retired phrase reappears there.
#
# Historical records are exempt: docs/designs/, docs/test-audit/,
# docs/incidents/, docs/plans/, docs/proposals/, docs/research/, docs/issues/,
# docs/superpowers/, docs/migrations/ and skills/migrations/ (release
# migration notes), and the wave 1 porting kit (docs/architecture/wave-1-*).
# CHANGELOG.md is outside the scanned set.
#
# The cut of gbrain's product retired its vocabulary too: none of its src/
# files, PGLite, brain tables or CLI commands are in this repository, so a
# sentence naming them describes code that is not here. src/ itself stays the
# place for product code (the ratchets scan src/**), so only a path into it
# is retired, not the directory name. Those rows scan
# scripts/, .github/ and package.json as well, where a stale path breaks a
# check instead of misleading a reader.
#
# Each failure prints FAIL / Why / Fix / See. To retire another phrase, add a
# row to RETIRED below (ERE pattern, TAB, the current instruction, and
# optionally TAB, why it is retired).
#
# Nothing to scan (none of the paths above exist): prints
# `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0, which `bun run verify` records
# as a skip, not a pass.
#
# Run: bash scripts/check-retired-phrases.sh
# Wired into `bun run verify` via package.json `check:retired-phrases`.
# Self-test seam: GBRAIN_GUARD_ROOT points at a fixture tree.

set -uo pipefail

ROOT="${GBRAIN_GUARD_ROOT:-$(git rev-parse --show-toplevel 2>/dev/null || pwd)}"
cd "$ROOT" || exit 2

SCAN=()
for p in CLAUDE.md AGENTS.md CONTRIBUTING.md docs skills scripts .github package.json; do
  [ -e "$p" ] && SCAN+=("$p")
done
if [ "${#SCAN[@]}" -eq 0 ]; then
  echo "✓ retired phrases: nothing to scan under $ROOT"
  echo "GBRAIN_CHECK_SKIPPED: none of the scanned docs, scripts or package.json exist"
  exit 0
fi

EXEMPT='^(docs/(designs|test-audit|incidents|plans|proposals|research|issues|superpowers|migrations)/|skills/migrations/|docs/architecture/wave-1-|scripts/check-retired-phrases\.sh$)'

# pattern<TAB>current instruction[<TAB>why]
# Read with `read -d ''`, never a `cat` heredoc inside a command substitution:
# macOS /bin/bash 3.2 quote-scans that heredoc and dies on the apostrophe and
# the odd backticks in these rows, so the guard could not even parse there.
IFS= read -r -d '' RETIRED <<'EOF' || true
MIGRATIONS`? array	Migrations are one file each: `bun run new:migration <snake_name>` scaffolds src/core/schema-migrations/v<NNN>-<name>.ts and regenerates registry.generated.ts; migrate.ts is only the runner.
append(s|ing)? (an entry |a migration |it )?to (the )?`?MIGRATIONS	Migrations are one file each: `bun run new:migration <snake_name>` (src/core/schema-migrations/), never an array append.
lands in BOTH	A migrated storage domain's SQL lives once in src/core/engine-sql/<domain>.ts and both engines delegate to it; only unmigrated or dialect-specific methods are written per engine (scripts/engine-sql-baseline.tsv).
Add the case to	A CLI-only command is a record in src/cli/command-table.ts plus its dispatch module src/cli/commands/<name>.ts, then `bun run build:flag-registry`.
region-exempt	The module-size ratchet has one policy (`ratchet`); migrate.ts is runner-only and ratcheted like every other file.
schema\.sql \+ pglite-schema\.ts|pglite-schema\.ts \+ schema\.sql	Schema DDL has one hand-edited copy: edit src/schema.sql (or the TS fragment its region banner names), then `bun run build:schema` regenerates schema-embedded.generated.ts and pglite-schema.generated.ts.
(^|[^A-Za-z0-9_./~-])src/[A-Za-z0-9_-]	describe this repository's own files with a path that exists, or delete the passage; gbrain itself is upstream, used as installed.	gbrain's product code was cut: none of its src/ files, PGLite, brain tables or CLI commands are in this repository
[Pp][Gg][Ll]ite	describe this repository's own files with a path that exists, or delete the passage; gbrain itself is upstream, used as installed.	gbrain's product code was cut: none of its src/ files, PGLite, brain tables or CLI commands are in this repository
\b(access_tokens|belief_commit_marks|belief_events|belief_page_lifetimes|belief_redactions|belief_retier_manifest|calibration_profiles|chat_usage_log|chronicle_judge_reservations|chronicle_page_state|code_edges_chunk|code_edges_symbol|content_chunks|context_volunteer_events|core_edit_notices|decide_calibrations|decide_proposals|decide_review_proposals|decide_review_queue|decide_spend|decide_state|decide_sweep_deferred|decision_receipts|derivation_inputs|derived_generation_activations|derived_generation_attempts|derived_generation_items|derived_generation_valve|derived_generations|dream_synthesis_completions|dream_verdicts|eval_candidates|eval_capture_failures|eval_contradictions_cache|eval_contradictions_runs|eval_takes_quality_runs|extract_atoms_page_state|extract_atoms_transcript_state|fact_purges|fact_relink_attempts|fact_withdrawals|file_migration_ledger|gbrain_cycle_locks|git_canonical_brain|ingest_log|link_edge_proposals|link_relationships|link_transitions|loop_suppressions|mcp_request_log|migration_impact_log|minion_attachments|minion_inbox|minion_jobs|needs_rederive|oauth_clients|oauth_codes|oauth_grant_audit|oauth_tokens|op_checkpoint_paths|op_checkpoints|open_loops|page_body_manifest|page_body_staging_parts|page_body_staging_texts|page_body_stagings|page_derivation_spend|page_embedding_budget|page_extraction_state|page_generation_clock|page_projection_jobs|page_purges|page_retrievals|page_segment_derivation_purge_pages|page_segment_derivation_purges|page_segment_derivations|page_segment_texts|page_versions|page_view_digests|page_write_guards|persistence_brain|persistence_consumers|persistence_counters|persistence_effects|persistence_host_bindings|persistence_local_writers|persistence_requests|persistence_source_bindings|persistence_topology_changes|persistence_worktree_refreshes|persistence_worktrees|persistence_writer_protocols|pinned_questions|question_evidence|raw_data|retrieval_event_links|retrieval_event_pages|retrieval_events|retrieval_feedback|retrieval_weights|session_context_state|shared_skill_delivery_batches|shared_skill_heads|shared_skill_members|shared_skill_packs|shared_skill_policies|shared_skill_policy_audit|shared_skill_revision_leases|shared_skill_revisions|shared_skill_state|source_ingestion_receipts|subagent_messages|subagent_rate_leases|subagent_tool_executions|sync_notifier_leases|sync_notifier_sources|sync_wanted_markers|take_grade_cache|take_nudge_log|take_proposals|take_purges|think_ab_results|timeline_entries|wanted_links|write_gate_holds|write_gate_receipts)\b	describe this repository's own files with a path that exists, or delete the passage; gbrain itself is upstream, used as installed.	gbrain's product code was cut: none of its src/ files, PGLite, brain tables or CLI commands are in this repository
\bgbrain (access|advisor|agent|anomalies|append|apply-migrations|auth|autopilot|backfill|backup|beliefs|bench|book-mirror|bootstrap|brainstorm|bundled-skill|cache|calibration|call|capture|check-backlinks|check-resolvable|check-update|claw-test|code-callees|code-callers|code-def|code-refs|compile-context|config|connect|connectors|conversation-parser|core|creds|db-repair|decide|diag|doctor|dream|edge-proposals|edges-backfill|embed|embeddings|engine|enrich|errors|eval|export|extract|extract-conversation-facts|facts|features|feedback|files|forget|founder|friction|frontmatter|git|google|graph-query|hook|import|init|integrations|integrity|jobs|lint|loops|lsd|maintain|mcp|memory-proposals|migrate|models|mounts|notability-eval|notices|onboard|orphans|pages|pglite-repair|post-upgrade|pricing|projections|protocol|providers|publish|quarantine|questions|recall|reconcile-links|reindex|reindex-code|reindex-frontmatter|reindex-search-vector|reinit-pglite|remote|repair|repair-jsonb|report|repos|resolvers|retrieval-upgrade|routing-eval|salience|schema|self-upgrade|serve|setup|skill-resolver|skillify|skillopt|skillpack|skillpack-check|smoke-test|sources|status|storage|sweep|sync|takes|think|transcripts|trust|upgrade|waiting|wakeshift|watch|whoknows)\b	describe this repository's own files with a path that exists, or delete the passage; gbrain itself is upstream, used as installed.	gbrain's product code was cut: none of its src/ files, PGLite, brain tables or CLI commands are in this repository
EOF

fail=0
hits=0
while IFS=$'\t' read -r pattern fix why; do
  [ -n "$pattern" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    file="${hit%%:*}"
    if printf '%s\n' "$file" | grep -qE "$EXEMPT"; then continue; fi
    rest="${hit#*:}"
    line="${rest%%:*}"
    text="${rest#*:}"
    match=$(printf '%s\n' "$text" | grep -oE "$pattern" | head -1)
    hits=$((hits + 1))
    fail=1
    echo "FAIL: $file:$line retired phrase \"$match\"" >&2
    echo "Why:  ${why:-refactor wave 1 retired this workflow}; agents follow these docs literally and would edit the wrong file." >&2
    echo "Fix:  rewrite the sentence to the current instruction: $fix" >&2
    echo "See:  docs/TESTING.md#retired-phrase-guard" >&2
  done < <(grep -rnIE "$pattern" "${SCAN[@]}" 2>/dev/null || true)
done <<< "$RETIRED"

if [ "$fail" -ne 0 ]; then
  echo "" >&2
  echo "✗ retired phrases: $hits hit(s) in ${SCAN[*]}" >&2
  exit 1
fi
echo "✓ retired phrases: none in ${SCAN[*]} (historical records exempt)"
