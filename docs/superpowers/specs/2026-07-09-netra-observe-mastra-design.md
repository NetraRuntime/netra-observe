# netra-observe TypeScript SDK — Mastra integration design

Date: 2026-07-09
Status: approved for planning
Related: `js/FINDINGS.md` (LangChain.js path paused on ESM/openai@6 blocker)

## Goal

Full-parity Netra observability for [Mastra](https://github.com/mastra-ai/mastra)
apps, in the existing `@netra/observe` package:

1. **Export** — Mastra AI-tracing spans exported to the Netra OTLP endpoint as
   OpenInference-conventioned OTel spans (the same attribute shape the Python
   SDK emits, so the backend sees one consistent format).
2. **Join** — model calls routed through the Netra gateway carry a
   `traceparent` header matching the exported model-generation span, so
   gateway-side records join the app trace.

## User-facing API (decided)

One touch point. `NetraExporter` does everything:

```ts
import { Mastra } from "@mastra/core/mastra"
import { NetraExporter } from "@netra/observe/mastra"

export const mastra = new Mastra({
    agents: { myAgent },
    observability: {
        configs: {
            netra: { exporters: [new NetraExporter()] },
        },
    },
})
```

`new NetraExporter(options?)` accepts the same options as `instrument()`
(`apiKey`, host/endpoint, `gatewayHost`) with the same env fallbacks via the
existing `resolveConfig`. The constructor installs the gateway fetch patch;
`shutdown()` (called by Mastra) uninstalls it and flushes.

## Why this approach works where LangChain.js stalled

The paused LangChain path depended on OpenInference *module patching*
(broken for ESM + openai@6). Mastra needs neither module patching nor a
preload:

- Mastra **calls our exporter** through its documented exporter interface
  (the `init(options)` / tracing-event / `flush()` / `shutdown()` contract
  that `@mastra/otel-exporter` follows, receiving `SPAN_ENDED` events).
- Mastra exposes the ambient span via its public AsyncLocalStorage helper
  `getCurrentSpan()` (`@mastra/core/observability`), populated by
  `executeWithContext(modelSpan, () => model.generate…)` around model calls.
- Mastra span IDs are W3C-format: its own otel-exporter uses `span.traceId` /
  `span.id` **verbatim** as OTel trace/span IDs. We do the same, which is what
  makes the export lane and the join lane share IDs.

## Architecture

New subpath export `@netra/observe/mastra` in `js/`. `@mastra/core` becomes an
optional peer dependency (like `@langchain/core`). Nothing Mastra-related loads
from the main entry.

### Components (`js/src/mastra/`)

1. **`exporter.ts` — `NetraExporter`.** Implements Mastra's tracing-exporter
   interface. Owns a `BatchSpanProcessor` + OTLP/HTTP-proto `SpanExporter`
   pointed at the Netra traces endpoint — no `NodeTracerProvider`, no global
   OTel registration, no OpenInference instrumentation packages. On
   `SPAN_ENDED` events: convert and enqueue. Constructor installs the gateway
   fetch patch idempotently (two exporter instances must not double-patch).

2. **`convert.ts` — span converter.** Mastra exported span → OpenInference
   `ReadableSpan`, matching the Python SDK's shape:
   - `openinference.span.kind`: LLM/model generation → `LLM`, tool call →
     `TOOL`, agent run → `AGENT`, workflow/step/other → `CHAIN`.
   - `input.value` / `output.value` (JSON-stringified when non-string).
   - `llm.model_name`, `llm.token_count.prompt|completion|total` from usage.
   - `mastra.metadata.*` passthrough; root-span tags as `mastra.tags`.
   - Trace/span/parent IDs taken verbatim from the Mastra span.
   - Resource: existing `resource.ts` service attributes.

3. **`inject.ts` extension (existing file).** `install()` gains a pluggable
   span-context source list. The Mastra source lazily imports
   `getCurrentSpan()` and returns `{ traceId, spanId }` from the live span.
   Order: Mastra source first, OTel active span fallback. Gateway-host scoping
   unchanged.

### Reused building blocks

`config.ts` (`resolveConfig`, host normalization), the OTLP exporter
construction from `provider.ts` (refactored so exporter construction is usable
without building a provider), `inject.ts` (extended as above).

## Data flow

Two lanes sharing one set of IDs:

- **Export lane:** agent/workflow run → Mastra AI-tracing spans →
  `SPAN_ENDED` events → `NetraExporter` → converter → `BatchSpanProcessor` →
  OTLP/proto POST to Netra.
- **Join lane:** Mastra runs the model call inside
  `executeWithContext(modelSpan, …)` → AI SDK fetches the Netra gateway → the
  patch matches the gateway host → `getCurrentSpan()` →
  `traceparent: 00-{span.traceId}-{span.id}-01` injected → gateway record
  joins the exported trace.

## Error handling

- Exporter methods never throw into Mastra: all handlers catch and
  `diag.debug`, matching existing SDK style.
- Unresolvable config (no API key/endpoint) disables the exporter with a
  single warning; the app keeps running.
- Missing `@mastra/core` only surfaces when importing the `/mastra` subpath.
- Fetch-patch failures fall through to the unpatched request — tracing must
  never break a model call.
- `flush()`/`shutdown()` bounded by timeout as in `instrument.ts`.

## Testing

- **Spike first (go/no-go):** integration test proving that inside the
  outbound fetch of a real Mastra agent run (mocked model endpoint),
  `getCurrentSpan()` returns the model-generation span and the injected
  traceparent matches the span the exporter exports. This is the one
  empirical unknown; if the ambient span at fetch time is a different span
  (e.g. the agent span), the join target degrades gracefully to that span —
  still the same trace ID — and the spike documents which span joins.
- Unit tests: converter (each span type, token counts, metadata,
  ID passthrough), exporter lifecycle (ignores non-`SPAN_ENDED` events,
  flush/shutdown, disabled-on-bad-config, idempotent patch install),
  inject source ordering (Mastra beats OTel; OTel fallback intact).
- `examples/mastra_agent.ts` + README section mirroring the LangChain example.

## Out of scope

- Mastra log export (traces only, like the rest of the SDK).
- The paused LangChain.js path (unchanged by this work).
- Mastra legacy `telemetry` (OTel) config — we target AI tracing
  (`observability` config) only.

## Verification notes for implementation

Interface details to pin during the spike (from the installed `@mastra/core`
version, not assumed): the exact exporter interface/type name and whether
implementing it directly suffices or `BaseExporter` from
`@mastra/observability` is required; the exact `SpanType` enum members; the
usage/token field names on model-generation spans.
