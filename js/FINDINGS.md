# netra-observe TypeScript SDK — status & findings (2026-07-08)

**Status: PAUSED.** The proven-injection core is built and unit-tested, but a
compatibility blocker in the upstream instrumentation stack prevents a working
LangChain.js / OpenAI-SDK release. This document records what works, what
doesn't, and the robust path forward, so the next effort starts from evidence.

Spec: `frontend/docs/superpowers/specs/2026-07-08-netra-observe-typescript-design.md`
Plan: `frontend/docs/superpowers/plans/2026-07-08-netra-observe-typescript.md`

## What is built and passing (Tasks 1–5, committed, 18 unit tests)

- `config.ts` — `resolveConfig` / `normalizeHost`, env fallbacks. ✅
- `provider.ts` — resource + OTLP/HTTP exporter + batch provider. ✅
- `context.ts` — `activeSpanContext()` reads the OTel active span. ✅
- `inject.ts` — gateway-scoped `fetch` patch injecting `traceparent`. ✅
- `instrument.ts` — `instrument()`: provider + register + instrumentations +
  fetch patch + handle (flush/shutdown/asyncDispose). ✅
- `test/spike.test.ts` — proves the injection primitive end-to-end against an
  **instrumented `openai@5` client loaded via CommonJS `require`**. ✅

The injection mechanism itself is sound: when the LLM SDK's call is wrapped in
an active OTel span, reading `trace.getSpan(context.active())` at fetch time
yields that span, and the injected traceparent matches the exported span.

## The blocker

The mechanism depends on the LLM SDK's call being an **active** OTel span. In
the current modern stack that does not happen:

| Path | Result |
| --- | --- |
| `openai@5` via CommonJS `require` (the spike) | ✅ patched → active span → join works |
| `openai@6` via ESM `import` (direct) | ❌ **not patched** by OpenInference → no span |
| `@langchain/openai@1` → nested `openai@6` (ESM) | ❌ openai not patched; only a LangChain `ChatOpenAI` span is created, and it is **not active** at fetch time |

Root causes, established empirically (probes, not assumption):

1. **OpenInference's OpenAI/Anthropic instrumentations don't handle `openai@6`
   under ESM.** Their module definition claims `["^6.0.0","^5.0.0"]` but with a
   "5.x is best effort" note; a direct `await import("openai")` (v6) produces
   **zero** spans even with `import-in-the-middle` registered. They were built
   against the CJS/v4–v5 shape.
2. **The OpenInference LangChain instrumentation works** (via
   `manuallyInstrument` on the ESM callback-manager module — spans get created),
   **but its `ChatOpenAI` span is not active** during the outbound fetch
   (`context.active()` is empty), and the OTel span is **not reachable by run
   id** from the instrumentor instance (`oiTracer` exposes only
   `{ tracer, config }` — the run→span map lives on an internal LangChain
   tracer created per callback-manager).
3. **ESM instrumentation needs a preload.** A runtime `instrument()` cannot
   instrument statically-imported ESM modules (imports hoist above all code) and
   patches the CJS copy, not the ESM one the app uses. A
   `node --import @netra/observe/register` preload (register IITM +
   `manuallyInstrument` the ESM callback manager) fixes span *creation* for
   LangChain — verified — but does **not** fix (1)/(2), so the join still fails.

Net: with the OpenInference-instrumentation approach, we can create LangChain
spans but cannot inject the correct span's traceparent for the modern
ESM + `openai@6` stack.

## Robust path forward (when resumed)

Write **our own LangChain callback-handler tracer** instead of relying on
OpenInference's LangChain instrumentation + the openai instrumentation:

- Extend LangChain's public `BaseTracer` / `BaseCallbackHandler` (a stable,
  documented API — not module patching), emit OpenInference-conventioned OTel
  spans (`openinference.span.kind`, `input.value`, `output.value`,
  `llm.token_count.*`, tool calls), and **own the run→span map**.
- Read the current run at fetch time via LangChain's AsyncLocalStorage: after
  `AsyncLocalStorageProviderSingleton.initializeGlobalInstance(new AsyncLocalStorage())`,
  `getStore()` inside a run returns the live Run node with `.id` (verified) —
  map that to our span's context and inject.
- Ship it behind the `--import @netra/observe/register` preload (the preload
  pattern is already validated).

This is version-robust (independent of openai/ESM churn) and covers the
headline LangChain use case. Direct OpenAI/Anthropic-SDK support (no LangChain)
waits on OpenInference handling `openai@6`/ESM, or on us writing our own client
instrumentation.

## Reproductions

All findings above are reproducible with short scripts run from this directory
(`node --import ...` for the preload path; `npx tsx` for the inline probes).
The committed `test/spike.test.ts` is the positive control (CJS `openai@5`).

## Update 2026-07-09: Mastra integration shipped

The Mastra path does not depend on the blocked OpenInference stack and is
live: `NetraExporter` (`@netra/observe/mastra`) receives spans through
Mastra's documented exporter interface and reads the ambient span via
`resolveCurrentSpan()` for the gateway join — no module patching, no
preload. Spec: `docs/superpowers/specs/2026-07-09-netra-observe-mastra-design.md`.
The LangChain.js blocker and its robust path forward above remain accurate.
