# GET /v1/agent/status identity contract (OQ-3; main, live read-only on ops, Sun 1 Nov 2026 ~11:00Z; backend live master a9257ecd)
Recorded with cliff's key (bound to exactly one agent). Key loaded in-process, never printed; files hold names, ids and codes only.

1. Envelope: the JSON body is `{"data": {...}}`. Unwrap `data` first.
2. The `identity` object is returned ONLY in the default compact mode (no query, or `compact` not 0/false). `?exact=1` or `?fast=0` omits it (status-route.ts:180-193). The installer must call the default form.
3. Shape (status-route.ts:290-297): `identity = { account_id, api_key_id, agent_id, bound_agent_ids: boundAgentIds(statusCtx) || [] }`.
   - bound to one: `bound_agent_ids` = [that id] (recorded: status-identity-bound-one.json; account_id / api_key_id are same-length placeholders).
   - unbound key: `bound_agent_ids` = [] (the `|| []`).
   - bound to several: an array of N ids; compare as a SET (no order is promised).
4. Request header (recorded: status-variants-shape.json):
   - NO X-Marrow-Agent-Id header -> 200 with `identity`; `identity.agent_id` is in `bound_agent_ids`.
   - a WRONG X-Marrow-Agent-Id (not in the binding) -> 403, top-level keys `code`, `details`, `error` ("Agent-bound key cannot access another agent."); no `identity`. The body does name the bound id, but the installer must NOT read ids from an error body (A-MM6/7: nothing from an error body is used or echoed).
   => --fix-identity and doctor's bound call send NO agent header and read `data.identity.bound_agent_ids` from a 200 only. Any non-200, a missing `data`/`identity`, a non-array `bound_agent_ids`, or an id failing SAFE_AGENT_ID = no change, exit 4 (INS-1 T12).
5. Other fields that carry the binding (exact mode only, for reference; not a contract): `outcome_coverage_details.scope.agent_ids` (= boundAgentIds), `control_coverage.coverage_scope.agent_ids`, `proof.scoped_to_bound_agent`, `diagnostics.agent_identity_accepted`.
