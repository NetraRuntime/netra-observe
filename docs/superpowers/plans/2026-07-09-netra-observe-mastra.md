# Mastra Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `@netra/observe/mastra` — a `NetraExporter` that exports Mastra AI-tracing spans to Netra as OpenInference-conventioned OTel spans AND injects the live Mastra span's traceparent into model calls routed through the Netra gateway.

**Architecture:** `NetraExporter` implements Mastra's `ObservabilityExporter` interface (`@mastra/core/observability`): on `SPAN_ENDED` events it converts the Mastra span to an OpenInference `ReadableSpan` (IDs verbatim — Mastra IDs are W3C-format) and pushes it through the existing `BatchSpanProcessor`/OTLP-proto exporter from `provider.ts`. The existing gateway fetch patch (`inject.ts`) gains pluggable span-context sources; the Mastra source reads `resolveCurrentSpan()` (Mastra's public AsyncLocalStorage helper) at fetch time. Same IDs in both lanes → the gateway record joins the exported trace. No module patching, no preload, no OpenInference instrumentation packages.

**Tech Stack:** TypeScript (strict, ESM, `"type": "module"`), vitest, `@opentelemetry/sdk-trace-base` 2.x, `@opentelemetry/exporter-trace-otlp-proto`, `@mastra/core` ^1.50 (optional peer).

Spec: `docs/superpowers/specs/2026-07-09-netra-observe-mastra-design.md`

## Global Constraints

- All work in `js/`; run all commands from `/Users/rbisri/Documents/netra-observe/js`.
- Code style: match existing files — 4-space indent, no semicolons, double quotes, `.js` extensions on relative imports.
- Node >= 18. Package is ESM.
- Exporter code must NEVER throw into Mastra: catch and `diag.debug` (config errors: one `console.warn` then disabled mode).
- Nothing under `src/mastra/` may be imported from `src/index.ts` — `@mastra/core` loads only via the `/mastra` subpath.
- Mastra span IDs (`span.traceId`, `span.id`) are used **verbatim** as OTel trace/span IDs everywhere.
- OpenInference attribute conventions (`openinference.span.kind`, `input.value`, `llm.token_count.*`) — NOT OTel GenAI semconv (`gen_ai.*`).
- Tests: `npm test` (vitest). Typecheck: `npm run typecheck`.
- Commit after every task; message prefix `feat(js):` / `test(js):` / `docs(js):`.

---

### Task 1: Spike — prove the join (GO/NO-GO gate)

The one empirical unknown: during the outbound model-call fetch of a real Mastra agent run, does `resolveCurrentSpan()` return a span whose `traceId` matches the exported spans? If it does not, STOP after this task and report — the rest of the plan assumes it.

**Files:**
- Modify: `js/package.json` (devDependency, via npm install)
- Test: `js/test/mastra-spike.test.ts`

**Interfaces:**
- Consumes: `@mastra/core` public API only.
- Produces: empirical facts later tasks rely on — which `SpanType` is ambient at fetch time, and that its `traceId` matches the exported model span. Record both in the test's assertions and the commit message.

- [ ] **Step 1: Install @mastra/core as a devDependency**

Run: `npm install --save-dev @mastra/core@^1.50.1`
Expected: package.json devDependencies gains `"@mastra/core": "^1.50.1"`; install succeeds.

- [ ] **Step 2: Write the spike test**

Create `js/test/mastra-spike.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core/mastra"
import { resolveCurrentSpan, TracingEventType } from "@mastra/core/observability"
import type { AnySpan, TracingEvent } from "@mastra/core/observability"

/** OpenAI-compatible chat-completions mock. */
function mockGateway(): Promise<{ port: number; close: () => void }> {
    return new Promise((resolve) => {
        const srv: Server = createServer((req, res) => {
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    id: "chatcmpl-spike",
                    object: "chat.completion",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "hi" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                    },
                })
            )
        })
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as { port: number }).port
            resolve({ port, close: () => srv.close() })
        })
    })
}

const origFetch = globalThis.fetch

afterEach(() => {
    globalThis.fetch = origFetch
})

describe("mastra spike: ambient span at model-call fetch time", () => {
    it("resolveCurrentSpan() inside the outbound fetch shares the exported trace id", async () => {
        const gw = await mockGateway()

        // Record the ambient Mastra span at fetch time (the injection read).
        const seen: { url: string; span: AnySpan | undefined }[] = []
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url
            seen.push({ url, span: resolveCurrentSpan() })
            return origFetch(input, init)
        }) as typeof globalThis.fetch

        // Capture every ended exported span (the export lane).
        const events: TracingEvent[] = []
        const capture = {
            name: "capture",
            exportTracingEvent: async (e: TracingEvent) => {
                events.push(e)
            },
            flush: async () => {},
            shutdown: async () => {},
        }

        const agent = new Agent({
            name: "spike",
            instructions: "Answer briefly.",
            model: {
                providerId: "netra",
                modelId: "test-model",
                url: `http://127.0.0.1:${gw.port}/v1`,
                apiKey: "test-key",
            },
        })
        const mastra = new Mastra({
            agents: { spike: agent },
            observability: {
                configs: { capture: { exporters: [capture] } },
            },
        })

        await mastra.getAgent("spike").generate("hello")
        // SPAN_ENDED delivery can lag the generate() return by a tick.
        await new Promise((r) => setTimeout(r, 200))
        gw.close()

        // The model call hit our gateway with an ambient Mastra span.
        const gwCalls = seen.filter((s) =>
            s.url.includes(`127.0.0.1:${gw.port}`)
        )
        expect(gwCalls.length).toBeGreaterThan(0)
        const ambient = gwCalls[0].span
        expect(ambient).toBeDefined()
        expect(ambient!.traceId).toMatch(/^[0-9a-f]{32}$/)
        expect(ambient!.id).toMatch(/^[0-9a-f]{16}$/)

        // The ambient span belongs to the same trace as the exported spans.
        const ended = events
            .filter((e) => e.type === TracingEventType.SPAN_ENDED)
            .map((e) => e.exportedSpan)
        expect(ended.length).toBeGreaterThan(0)
        expect(ended.some((s) => s.traceId === ambient!.traceId)).toBe(true)

        // Document which span kind is ambient at fetch time — the join target.
        // (Expected: a model_* span; agent_run would still join the trace.)
        console.info(
            `spike: ambient span at fetch time — type=${ambient!.type} ` +
                `id=${ambient!.id} traceId=${ambient!.traceId}`
        )
        expect(String(ambient!.type)).toBeTruthy()
    })
})
```

- [ ] **Step 3: Run the spike**

Run: `npx vitest run test/mastra-spike.test.ts`
Expected: PASS, with a `spike: ambient span at fetch time — type=…` line in the output. Note the `type=` value.

If it FAILS because `resolveCurrentSpan()` returns `undefined` at fetch time: **STOP the plan.** Update `js/FINDINGS.md` with the negative result (mirror the existing blocker-documentation style: what was probed, what was observed) and report back — the join lane needs a different mechanism and the spec must be revisited. Ordinary breakage (wrong import path, agent/model config shape drift) is not a NO-GO — fix against the installed `@mastra/core` types and re-run.

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json test/mastra-spike.test.ts
git commit -m "test(js): mastra spike — ambient span at fetch time joins the exported trace

Ambient span type at fetch time: <type from step 3 output>"
```

---

### Task 2: Pluggable span-context sources in inject.ts

**Files:**
- Modify: `js/src/inject.ts`
- Modify: `js/test/inject.test.ts` (append tests)

**Interfaces:**
- Consumes: existing `install(host)` / `uninstall()` / `activeSpanContext()`.
- Produces (later tasks rely on these exact signatures):
  - `type SpanContextSource = () => { traceId: string; spanId: string } | undefined`
  - `addSpanContextSource(src: SpanContextSource): void`
  - `removeSpanContextSource(src: SpanContextSource): void`
  - `install(host: string): boolean` — now returns `true` only when THIS call performed the patch (`false` when already installed; it still retargets the host).
  - Source order: added sources first (FIFO), OTel `activeSpanContext()` as final fallback. A throwing source is skipped.

- [ ] **Step 1: Write the failing tests**

Append to `js/test/inject.test.ts` (inside the existing `describe("inject", …)` block; imports at top of file change to):

```ts
import {
    install,
    uninstall,
    addSpanContextSource,
    removeSpanContextSource,
} from "../src/inject.js"
```

New tests:

```ts
    it("prefers an added source over the OTel active span", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => ({
            traceId: "1".repeat(32),
            spanId: "2".repeat(16),
        })
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"1".repeat(32)}-${"2".repeat(16)}-01`
        )
        cap.close()
    })

    it("falls back to the OTel active span when sources return undefined", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => undefined
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )
        cap.close()
    })

    it("a throwing source is skipped, not fatal", async () => {
        const cap = await capture()
        mockActive.mockReturnValue({
            traceId: "a".repeat(32),
            spanId: "b".repeat(16),
        })
        const source = () => {
            throw new Error("boom")
        }
        addSpanContextSource(source)
        install(cap.host)
        await fetch(`http://${cap.host}/x`)
        removeSpanContextSource(source)
        expect(cap.got[0]["traceparent"]).toBe(
            `00-${"a".repeat(32)}-${"b".repeat(16)}-01`
        )
        cap.close()
    })

    it("install returns true only for the call that patched", () => {
        expect(install("h1")).toBe(true)
        expect(install("h2")).toBe(false)
        uninstall()
        expect(install("h3")).toBe(true)
        uninstall()
    })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `npx vitest run test/inject.test.ts`
Expected: FAIL — `addSpanContextSource` is not exported (compile error) or assertion failures. The 5 pre-existing tests must not be touched.

- [ ] **Step 3: Implement in inject.ts**

Replace `js/src/inject.ts`'s `traceparentHeaders` and `install`, and add the source registry (keep `requestHost` and `uninstall` as they are):

```ts
export type SpanContextSource = () =>
    | { traceId: string; spanId: string }
    | undefined

let sources: SpanContextSource[] = []

/** Register an additional span-context source consulted BEFORE the OTel
 * active span (FIFO among added sources). Used by the Mastra integration,
 * whose spans are not OTel-active. */
export function addSpanContextSource(src: SpanContextSource): void {
    if (!sources.includes(src)) sources.push(src)
}

export function removeSpanContextSource(src: SpanContextSource): void {
    sources = sources.filter((s) => s !== src)
}

function currentSpanContext():
    | { traceId: string; spanId: string }
    | undefined {
    for (const src of sources) {
        try {
            const sc = src()
            if (sc) return sc
        } catch {
            /* a broken source must not break the request */
        }
    }
    return activeSpanContext()
}

function traceparentHeaders(base?: HeadersInit): Headers {
    const headers = new Headers(base)
    const sc = currentSpanContext()
    if (sc) headers.set("traceparent", `00-${sc.traceId}-${sc.spanId}-01`)
    return headers
}
```

And change `install`'s signature/returns (body otherwise unchanged):

```ts
/** Patch global fetch to inject the current LLM span's traceparent on
 * requests to the gateway host. Idempotent — a second call just retargets
 * the host and returns false; true means this call performed the patch
 * (its caller owns the eventual uninstall()). Never throws into the
 * caller; on any error the request goes out untouched. */
export function install(host: string): boolean {
    gatewayHost = host
    if (original) return false
    original = globalThis.fetch
    // … existing patch body unchanged …
    return true
}
```

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all pre-existing tests (config, inject, instrument, provider, spike, mastra-spike) plus the 4 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/inject.ts test/inject.test.ts
git commit -m "feat(js): pluggable span-context sources in the fetch patch; install() reports ownership"
```

---

### Task 3: Mastra span source

**Files:**
- Create: `js/src/mastra/span-source.ts`
- Test: `js/test/mastra-span-source.test.ts`

**Interfaces:**
- Consumes: `resolveCurrentSpan(): AnySpan | undefined` from `@mastra/core/observability`.
- Produces: `mastraSpanContext(): { traceId: string; spanId: string } | undefined` — a `SpanContextSource` (Task 2 type) returning the live Mastra span's ids, lowercased, or `undefined` when absent/malformed. Never throws.

- [ ] **Step 1: Write the failing tests**

Create `js/test/mastra-span-source.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from "vitest"

vi.mock("@mastra/core/observability", () => ({
    resolveCurrentSpan: vi.fn(),
}))
import { resolveCurrentSpan } from "@mastra/core/observability"
import { mastraSpanContext } from "../src/mastra/span-source.js"

const mockResolve = resolveCurrentSpan as unknown as ReturnType<typeof vi.fn>

afterEach(() => mockResolve.mockReset())

describe("mastraSpanContext", () => {
    it("returns the live span's ids, lowercased", () => {
        mockResolve.mockReturnValue({
            traceId: "4BF92F3577B34DA6A3CE929D0E0E4736",
            id: "00F067AA0BA902B7",
        })
        expect(mastraSpanContext()).toEqual({
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            spanId: "00f067aa0ba902b7",
        })
    })

    it("returns undefined when no span is ambient", () => {
        mockResolve.mockReturnValue(undefined)
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined for non-W3C ids", () => {
        mockResolve.mockReturnValue({ traceId: "not-hex", id: "short" })
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined for all-zero ids", () => {
        mockResolve.mockReturnValue({
            traceId: "0".repeat(32),
            id: "0".repeat(16),
        })
        expect(mastraSpanContext()).toBeUndefined()
    })

    it("returns undefined when the resolver throws", () => {
        mockResolve.mockImplementation(() => {
            throw new Error("boom")
        })
        expect(mastraSpanContext()).toBeUndefined()
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mastra-span-source.test.ts`
Expected: FAIL — cannot resolve `../src/mastra/span-source.js`.

- [ ] **Step 3: Implement**

Create `js/src/mastra/span-source.ts`:

```ts
import { resolveCurrentSpan } from "@mastra/core/observability"

const TRACE_ID = /^[0-9a-f]{32}$/
const SPAN_ID = /^[0-9a-f]{16}$/

/** Span-context source (see inject.ts) reading the live Mastra span from
 * Mastra's AsyncLocalStorage. Mastra wraps model calls in
 * executeWithContext(modelSpan, …), so during the outbound gateway fetch
 * this yields the model span whose ids the exporter also ships — the join.
 * Returns undefined outside a Mastra run or when ids aren't W3C-shaped. */
export function mastraSpanContext():
    | { traceId: string; spanId: string }
    | undefined {
    try {
        const span = resolveCurrentSpan()
        if (!span) return undefined
        const traceId = String(span.traceId ?? "").toLowerCase()
        const spanId = String(span.id ?? "").toLowerCase()
        if (!TRACE_ID.test(traceId) || !SPAN_ID.test(spanId)) return undefined
        if (traceId === "0".repeat(32) || spanId === "0".repeat(16))
            return undefined
        return { traceId, spanId }
    } catch {
        return undefined
    }
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/mastra-span-source.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mastra/span-source.ts test/mastra-span-source.test.ts
git commit -m "feat(js): mastra span-context source — live span ids from resolveCurrentSpan()"
```

---

### Task 4: Mastra → OpenInference span converter

**Files:**
- Create: `js/src/mastra/convert.ts`
- Test: `js/test/mastra-convert.test.ts`

**Interfaces:**
- Consumes: `AnyExportedSpan`, `SpanType` from `@mastra/core/observability`; `Resource` from `@opentelemetry/resources`; `VERSION` from `../instrument.js`.
- Produces: `convertSpan(span: AnyExportedSpan, resource: Resource): ReadableSpan` — OpenInference-conventioned, ids verbatim, `ended: true` always (event spans get `endTime = startTime`).

Mapping (authoritative):

| Mastra `SpanType` | `openinference.span.kind` |
| --- | --- |
| `MODEL_GENERATION`, `MODEL_STEP`, `MODEL_INFERENCE`, `MODEL_CHUNK` | `LLM` |
| `TOOL_CALL`, `MCP_TOOL_CALL`, `CLIENT_TOOL_CALL` | `TOOL` |
| `AGENT_RUN` | `AGENT` |
| `RAG_EMBEDDING` | `EMBEDDING` |
| `RAG_VECTOR_OPERATION` | `RETRIEVER` |
| everything else | `CHAIN` |

Attributes: `input.value`/`input.mime_type` and `output.value`/`output.mime_type` (strings pass through as `text/plain`; other values JSON-stringified as `application/json`; unserializable values dropped, span kept). `metadata` = JSON string of `span.metadata`. Root-span `tags` → `tag.tags` (string array). LLM spans add `llm.model_name` (`responseModel ?? model`), `llm.provider`, `llm.invocation_parameters` (JSON of `parameters`), `llm.token_count.prompt|completion|total` from `usage.inputTokens`/`usage.outputTokens`. TOOL spans add `tool.name` (`entityName ?? span.name`). `errorInfo` → status `ERROR` + one `exception` event (`exception.message`, optional `exception.type` from `errorInfo.name`, `exception.stacktrace` from `errorInfo.stack`); otherwise status `OK`.

- [ ] **Step 1: Write the failing tests**

Create `js/test/mastra-convert.test.ts`:

```ts
import { describe, it, expect } from "vitest"
import { resourceFromAttributes } from "@opentelemetry/resources"
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api"
import { SpanType } from "@mastra/core/observability"
import type { AnyExportedSpan } from "@mastra/core/observability"
import { convertSpan } from "../src/mastra/convert.js"

const resource = resourceFromAttributes({ "service.name": "t" })
const T0 = new Date("2026-07-09T00:00:00.000Z")
const T1 = new Date("2026-07-09T00:00:01.500Z")

function base(over: Partial<AnyExportedSpan> = {}): AnyExportedSpan {
    return {
        id: "00f067aa0ba902b7",
        traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
        name: "span",
        type: SpanType.GENERIC,
        startTime: T0,
        endTime: T1,
        isRootSpan: false,
        isEvent: false,
        ...over,
    } as AnyExportedSpan
}

describe("convertSpan", () => {
    it("model_generation → LLM with ids verbatim and token counts", () => {
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                name: "gen",
                parentSpanId: "aaaaaaaaaaaaaaaa",
                input: [{ role: "user", content: "hi" }],
                output: { role: "assistant", content: "hello" },
                attributes: {
                    model: "gpt-4o-mini",
                    provider: "openai",
                    usage: { inputTokens: 7, outputTokens: 3 },
                    parameters: { temperature: 0 },
                },
            }),
            resource
        )
        expect(s.spanContext().traceId).toBe(
            "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        expect(s.spanContext().spanId).toBe("00f067aa0ba902b7")
        expect(s.spanContext().traceFlags).toBe(TraceFlags.SAMPLED)
        expect(s.parentSpanContext?.spanId).toBe("aaaaaaaaaaaaaaaa")
        expect(s.kind).toBe(SpanKind.INTERNAL)
        expect(s.attributes["openinference.span.kind"]).toBe("LLM")
        expect(s.attributes["llm.model_name"]).toBe("gpt-4o-mini")
        expect(s.attributes["llm.provider"]).toBe("openai")
        expect(s.attributes["llm.invocation_parameters"]).toBe(
            JSON.stringify({ temperature: 0 })
        )
        expect(s.attributes["llm.token_count.prompt"]).toBe(7)
        expect(s.attributes["llm.token_count.completion"]).toBe(3)
        expect(s.attributes["llm.token_count.total"]).toBe(10)
        expect(s.attributes["input.mime_type"]).toBe("application/json")
        expect(s.attributes["output.mime_type"]).toBe("application/json")
        expect(JSON.parse(String(s.attributes["input.value"]))).toEqual([
            { role: "user", content: "hi" },
        ])
        expect(s.ended).toBe(true)
        expect(s.status.code).toBe(SpanStatusCode.OK)
    })

    it("responseModel wins over model for llm.model_name", () => {
        const s = convertSpan(
            base({
                type: SpanType.MODEL_GENERATION,
                attributes: { model: "gpt-4o-mini", responseModel: "gpt-4o-mini-2026" },
            }),
            resource
        )
        expect(s.attributes["llm.model_name"]).toBe("gpt-4o-mini-2026")
    })

    it("tool_call → TOOL with tool.name from entityName", () => {
        const s = convertSpan(
            base({
                type: SpanType.TOOL_CALL,
                name: "tool run",
                entityName: "weather",
            }),
            resource
        )
        expect(s.attributes["openinference.span.kind"]).toBe("TOOL")
        expect(s.attributes["tool.name"]).toBe("weather")
    })

    it("agent_run root → AGENT with tags and metadata", () => {
        const s = convertSpan(
            base({
                type: SpanType.AGENT_RUN,
                isRootSpan: true,
                tags: ["prod", "beta"],
                metadata: { userId: "u1" },
            }),
            resource
        )
        expect(s.attributes["openinference.span.kind"]).toBe("AGENT")
        expect(s.attributes["tag.tags"]).toEqual(["prod", "beta"])
        expect(s.attributes["metadata"]).toBe(JSON.stringify({ userId: "u1" }))
    })

    it("workflow_step → CHAIN", () => {
        const s = convertSpan(base({ type: SpanType.WORKFLOW_STEP }), resource)
        expect(s.attributes["openinference.span.kind"]).toBe("CHAIN")
    })

    it("string input/output → text/plain", () => {
        const s = convertSpan(base({ input: "hi", output: "yo" }), resource)
        expect(s.attributes["input.value"]).toBe("hi")
        expect(s.attributes["input.mime_type"]).toBe("text/plain")
        expect(s.attributes["output.value"]).toBe("yo")
        expect(s.attributes["output.mime_type"]).toBe("text/plain")
    })

    it("errorInfo → ERROR status and exception event", () => {
        const s = convertSpan(
            base({
                errorInfo: {
                    message: "rate limited",
                    name: "APIError",
                    stack: "APIError: rate limited\n  at x",
                },
            }),
            resource
        )
        expect(s.status.code).toBe(SpanStatusCode.ERROR)
        expect(s.status.message).toBe("rate limited")
        expect(s.events).toHaveLength(1)
        expect(s.events[0].name).toBe("exception")
        expect(s.events[0].attributes?.["exception.message"]).toBe(
            "rate limited"
        )
        expect(s.events[0].attributes?.["exception.type"]).toBe("APIError")
    })

    it("event span (no endTime) → zero duration, still ended", () => {
        const s = convertSpan(
            base({ endTime: undefined, isEvent: true }),
            resource
        )
        expect(s.endTime).toEqual(s.startTime)
        expect(s.duration).toEqual([0, 0])
        expect(s.ended).toBe(true)
    })

    it("timing: 1.5s duration computed from start/end", () => {
        const s = convertSpan(base(), resource)
        expect(s.startTime).toEqual([Math.floor(T0.getTime() / 1000), 0])
        expect(s.duration).toEqual([1, 500_000_000])
    })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mastra-convert.test.ts`
Expected: FAIL — cannot resolve `../src/mastra/convert.js`.

- [ ] **Step 3: Implement**

Create `js/src/mastra/convert.ts`:

```ts
import { SpanKind, SpanStatusCode, TraceFlags } from "@opentelemetry/api"
import type { Attributes, HrTime } from "@opentelemetry/api"
import type { Resource } from "@opentelemetry/resources"
import type { ReadableSpan, TimedEvent } from "@opentelemetry/sdk-trace-base"
import { SpanType } from "@mastra/core/observability"
import type { AnyExportedSpan } from "@mastra/core/observability"

import { VERSION } from "../instrument.js"

const SCOPE = { name: "@netra/observe/mastra", version: VERSION }

function oiSpanKind(type: SpanType): string {
    switch (type) {
        case SpanType.MODEL_GENERATION:
        case SpanType.MODEL_STEP:
        case SpanType.MODEL_INFERENCE:
        case SpanType.MODEL_CHUNK:
            return "LLM"
        case SpanType.TOOL_CALL:
        case SpanType.MCP_TOOL_CALL:
        case SpanType.CLIENT_TOOL_CALL:
            return "TOOL"
        case SpanType.AGENT_RUN:
            return "AGENT"
        case SpanType.RAG_EMBEDDING:
            return "EMBEDDING"
        case SpanType.RAG_VECTOR_OPERATION:
            return "RETRIEVER"
        default:
            return "CHAIN"
    }
}

function setValue(
    attrs: Attributes,
    prefix: "input" | "output",
    value: unknown
): void {
    if (value === undefined || value === null) return
    if (typeof value === "string") {
        attrs[`${prefix}.value`] = value
        attrs[`${prefix}.mime_type`] = "text/plain"
        return
    }
    try {
        attrs[`${prefix}.value`] = JSON.stringify(value)
        attrs[`${prefix}.mime_type`] = "application/json"
    } catch {
        /* unserializable (circular) — drop the value, keep the span */
    }
}

function hrTime(d: Date): HrTime {
    const ms = d.getTime()
    return [Math.floor(ms / 1000), Math.round((ms % 1000) * 1e6)]
}

function hrDuration(start: Date, end: Date): HrTime {
    const ns = Math.max(0, (end.getTime() - start.getTime()) * 1e6)
    return [Math.floor(ns / 1e9), Math.round(ns % 1e9)]
}

/** Untyped view of the span-type-specific attributes we read. Mastra types
 * these per SpanType; we only touch fields shared by the model_* family. */
interface ModelishAttributes {
    model?: string
    responseModel?: string
    provider?: string
    usage?: { inputTokens?: number; outputTokens?: number }
    parameters?: Record<string, unknown>
}

/** Convert an ended Mastra exported span to an OpenInference-conventioned
 * OTel ReadableSpan. Trace/span/parent ids are Mastra's, verbatim — the
 * same ids the fetch patch injects, which is what joins the gateway record
 * to this exported span. */
export function convertSpan(
    span: AnyExportedSpan,
    resource: Resource
): ReadableSpan {
    const kind = oiSpanKind(span.type)
    const attrs: Attributes = { "openinference.span.kind": kind }

    setValue(attrs, "input", span.input)
    setValue(attrs, "output", span.output)

    if (span.metadata && Object.keys(span.metadata).length > 0) {
        try {
            attrs["metadata"] = JSON.stringify(span.metadata)
        } catch {
            /* unserializable metadata — skip */
        }
    }
    if (span.isRootSpan && span.tags?.length) attrs["tag.tags"] = span.tags

    if (kind === "LLM") {
        const a = (span.attributes ?? {}) as ModelishAttributes
        const model = a.responseModel ?? a.model
        if (model) attrs["llm.model_name"] = model
        if (a.provider) attrs["llm.provider"] = a.provider
        if (a.parameters) {
            try {
                attrs["llm.invocation_parameters"] = JSON.stringify(
                    a.parameters
                )
            } catch {
                /* skip */
            }
        }
        const prompt = a.usage?.inputTokens
        const completion = a.usage?.outputTokens
        if (prompt != null) attrs["llm.token_count.prompt"] = prompt
        if (completion != null)
            attrs["llm.token_count.completion"] = completion
        if (prompt != null || completion != null)
            attrs["llm.token_count.total"] = (prompt ?? 0) + (completion ?? 0)
    }

    if (kind === "TOOL") attrs["tool.name"] = span.entityName ?? span.name

    const end = span.endTime ?? span.startTime
    const endHr = hrTime(end)

    const events: TimedEvent[] = span.errorInfo
        ? [
              {
                  name: "exception",
                  time: endHr,
                  attributes: {
                      "exception.message": span.errorInfo.message,
                      ...(span.errorInfo.name && {
                          "exception.type": span.errorInfo.name,
                      }),
                      ...(span.errorInfo.stack && {
                          "exception.stacktrace": span.errorInfo.stack,
                      }),
                  },
                  droppedAttributesCount: 0,
              },
          ]
        : []

    return {
        name: span.name,
        kind: SpanKind.INTERNAL,
        spanContext: () => ({
            traceId: span.traceId,
            spanId: span.id,
            traceFlags: TraceFlags.SAMPLED,
            isRemote: false,
        }),
        parentSpanContext: span.parentSpanId
            ? {
                  traceId: span.traceId,
                  spanId: span.parentSpanId,
                  traceFlags: TraceFlags.SAMPLED,
                  isRemote: false,
              }
            : undefined,
        startTime: hrTime(span.startTime),
        endTime: endHr,
        duration: hrDuration(span.startTime, end),
        ended: true,
        status: span.errorInfo
            ? { code: SpanStatusCode.ERROR, message: span.errorInfo.message }
            : { code: SpanStatusCode.OK },
        attributes: attrs,
        links: [],
        events,
        resource,
        instrumentationScope: SCOPE,
        droppedAttributesCount: 0,
        droppedEventsCount: 0,
        droppedLinksCount: 0,
    }
}
```

If `tsc` reports `ReadableSpan` fields that differ from the above (OTel JS 2.x churn: `parentSpanContext` vs `parentSpanId`, `instrumentationScope` vs `instrumentationLibrary`), match the installed `@opentelemetry/sdk-trace-base` types — the shape above matches 2.9.x.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/mastra-convert.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/mastra/convert.ts test/mastra-convert.test.ts
git commit -m "feat(js): mastra→OpenInference span converter — ids verbatim, python-parity attributes"
```

---

### Task 5: NetraExporter + subpath entry

**Files:**
- Create: `js/src/mastra/exporter.ts`
- Create: `js/src/mastra/index.ts`
- Test: `js/test/mastra-exporter.test.ts`

**Interfaces:**
- Consumes: `resolveConfig` / `NetraConfigError` / `InstrumentOptions` (`../config.js`); `buildProcessor` / `buildResource` (`../provider.js`); `install` / `uninstall` / `addSpanContextSource` / `removeSpanContextSource` (`../inject.js`, Task 2); `convertSpan` (Task 4); `mastraSpanContext` (Task 3); `ObservabilityExporter`, `TracingEvent`, `TracingEventType` from `@mastra/core/observability`.
- Produces: `class NetraExporter implements ObservabilityExporter` with `name = "netra"`, `constructor(options?: NetraExporterOptions)`, `exportTracingEvent(event): Promise<void>`, `flush(): Promise<void>`, `shutdown(): Promise<void>`; `type NetraExporterOptions = InstrumentOptions`. Subpath entry `src/mastra/index.ts` re-exporting both plus `mastraSpanContext`.

- [ ] **Step 1: Write the failing tests**

Create `js/test/mastra-exporter.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { SpanType, TracingEventType } from "@mastra/core/observability"
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability"
import { NetraExporter } from "../src/mastra/index.js"

const OPTS = { apiKey: "k", endpoint: "http://127.0.0.1:1/otel" }

function endedEvent(over: Partial<AnyExportedSpan> = {}): TracingEvent {
    return {
        type: TracingEventType.SPAN_ENDED,
        exportedSpan: {
            id: "00f067aa0ba902b7",
            traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
            name: "s",
            type: SpanType.MODEL_GENERATION,
            startTime: new Date(),
            endTime: new Date(),
            isRootSpan: false,
            isEvent: false,
            ...over,
        } as AnyExportedSpan,
    }
}

function fakeProcessor() {
    return {
        onEnd: vi.fn(),
        forceFlush: vi.fn().mockResolvedValue(undefined),
        shutdown: vi.fn().mockResolvedValue(undefined),
    }
}

const origFetch = globalThis.fetch
let warn: ReturnType<typeof vi.spyOn>

beforeEach(() => {
    warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    vi.stubEnv("NETRA_API_KEY", "")
})

afterEach(async () => {
    warn.mockRestore()
    vi.unstubAllEnvs()
    globalThis.fetch = origFetch
})

describe("NetraExporter", () => {
    it("without config: warns once, disabled, never throws, no patch", async () => {
        const exp = new NetraExporter()
        expect(warn).toHaveBeenCalledTimes(1)
        expect(globalThis.fetch).toBe(origFetch)
        await expect(exp.exportTracingEvent(endedEvent())).resolves.toBeUndefined()
        await expect(exp.flush()).resolves.toBeUndefined()
        await expect(exp.shutdown()).resolves.toBeUndefined()
    })

    it("with config: patches fetch and converts SPAN_ENDED into the processor", async () => {
        const exp = new NetraExporter(OPTS)
        expect(globalThis.fetch).not.toBe(origFetch)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc

        await exp.exportTracingEvent(endedEvent())
        expect(proc.onEnd).toHaveBeenCalledTimes(1)
        const readable = proc.onEnd.mock.calls[0][0]
        expect(readable.spanContext().traceId).toBe(
            "4bf92f3577b34da6a3ce929d0e0e4736"
        )
        expect(readable.spanContext().spanId).toBe("00f067aa0ba902b7")
        expect(readable.attributes["openinference.span.kind"]).toBe("LLM")
        await exp.shutdown()
    })

    it("ignores SPAN_STARTED and SPAN_UPDATED", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc
        const span = endedEvent().exportedSpan
        await exp.exportTracingEvent({
            type: TracingEventType.SPAN_STARTED,
            exportedSpan: span,
        })
        await exp.exportTracingEvent({
            type: TracingEventType.SPAN_UPDATED,
            exportedSpan: span,
        })
        expect(proc.onEnd).not.toHaveBeenCalled()
        await exp.shutdown()
    })

    it("a converter blow-up is swallowed, not thrown into Mastra", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        proc.onEnd.mockImplementation(() => {
            throw new Error("boom")
        })
        ;(exp as any).processor = proc
        await expect(exp.exportTracingEvent(endedEvent())).resolves.toBeUndefined()
        await exp.shutdown()
    })

    it("flush and shutdown delegate to the processor; shutdown restores fetch", async () => {
        const exp = new NetraExporter(OPTS)
        const proc = fakeProcessor()
        ;(exp as any).processor = proc
        await exp.flush()
        expect(proc.forceFlush).toHaveBeenCalledTimes(1)
        await exp.shutdown()
        expect(proc.shutdown).toHaveBeenCalledTimes(1)
        expect(globalThis.fetch).toBe(origFetch)
    })

    it("second exporter does not double-patch nor un-patch on its shutdown", async () => {
        const first = new NetraExporter(OPTS)
        const patched = globalThis.fetch
        const second = new NetraExporter(OPTS)
        expect(globalThis.fetch).toBe(patched)
        await second.shutdown()
        expect(globalThis.fetch).toBe(patched)
        await first.shutdown()
        expect(globalThis.fetch).toBe(origFetch)
    })
})
```

Note: `vi.stubEnv("NETRA_API_KEY", "")` — empty string is falsy, so `resolveConfig` throws as if unset. If other `NETRA_*` env vars can leak into CI, stub them too.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/mastra-exporter.test.ts`
Expected: FAIL — cannot resolve `../src/mastra/index.js`.

- [ ] **Step 3: Implement exporter and subpath entry**

Create `js/src/mastra/exporter.ts`:

```ts
import { diag } from "@opentelemetry/api"
import type { Resource } from "@opentelemetry/resources"
import type { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { TracingEventType } from "@mastra/core/observability"
import type {
    ObservabilityExporter,
    TracingEvent,
} from "@mastra/core/observability"

import {
    resolveConfig,
    NetraConfigError,
    type InstrumentOptions,
} from "../config.js"
import { buildProcessor, buildResource } from "../provider.js"
import {
    install,
    uninstall,
    addSpanContextSource,
    removeSpanContextSource,
} from "../inject.js"
import { convertSpan } from "./convert.js"
import { mastraSpanContext } from "./span-source.js"

export type NetraExporterOptions = InstrumentOptions

/** Mastra observability exporter for Netra. Add it to the Mastra
 * constructor's observability config — one touch point:
 *
 *     new Mastra({
 *         observability: {
 *             configs: { netra: { exporters: [new NetraExporter()] } },
 *         },
 *     })
 *
 * It ships ended Mastra spans to the Netra OTLP endpoint as
 * OpenInference-conventioned OTel spans (ids verbatim) and patches global
 * fetch so model calls to the Netra gateway carry the live Mastra span's
 * traceparent — the gateway record joins the exported trace. Unresolvable
 * config disables the exporter with one warning; nothing here ever throws
 * into Mastra. */
export class NetraExporter implements ObservabilityExporter {
    name = "netra"

    private processor: BatchSpanProcessor | null = null
    private resource: Resource | null = null
    private ownsPatch = false

    constructor(options: NetraExporterOptions = {}) {
        let cfg
        try {
            cfg = resolveConfig(options)
        } catch (err) {
            if (err instanceof NetraConfigError) {
                console.warn(
                    `netra-observe: NetraExporter disabled — ${err.message}`
                )
                return
            }
            throw err
        }
        this.processor = buildProcessor(cfg)
        this.resource = buildResource(cfg)
        this.ownsPatch = install(cfg.gatewayHost)
        addSpanContextSource(mastraSpanContext)
    }

    async exportTracingEvent(event: TracingEvent): Promise<void> {
        if (!this.processor || !this.resource) return
        if (event.type !== TracingEventType.SPAN_ENDED) return
        try {
            this.processor.onEnd(
                convertSpan(event.exportedSpan, this.resource)
            )
        } catch (err) {
            diag.debug(
                `netra-observe: mastra span export failed: ${
                    (err as Error).message
                }`
            )
        }
    }

    async flush(): Promise<void> {
        try {
            await this.processor?.forceFlush()
        } catch (err) {
            diag.debug(
                `netra-observe: flush failed: ${(err as Error).message}`
            )
        }
    }

    async shutdown(): Promise<void> {
        removeSpanContextSource(mastraSpanContext)
        if (this.ownsPatch) {
            uninstall()
            this.ownsPatch = false
        }
        try {
            await this.processor?.shutdown()
        } catch (err) {
            diag.debug(
                `netra-observe: exporter shutdown failed: ${
                    (err as Error).message
                }`
            )
        }
        this.processor = null
    }
}
```

Create `js/src/mastra/index.ts`:

```ts
export { NetraExporter } from "./exporter.js"
export type { NetraExporterOptions } from "./exporter.js"
export { mastraSpanContext } from "./span-source.js"
```

Type note: `BatchSpanProcessor.onEnd(span: ReadableSpan)` is the public
processor API in sdk-trace-base 2.x — the same call Mastra's own
otel-exporter makes. If `implements ObservabilityExporter` reports missing
optional members, they are optional (`init?`, `__setLogger?`, `on*?`) —
do not add stubs for them.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS — all suites including the 6 new exporter tests.

- [ ] **Step 5: Commit**

```bash
git add src/mastra/exporter.ts src/mastra/index.ts test/mastra-exporter.test.ts
git commit -m "feat(js): NetraExporter — mastra exporter with OTLP export + gateway fetch patch"
```

---

### Task 6: Packaging — subpath export, peer dep, build config

**Files:**
- Modify: `js/package.json`
- Create: `js/tsup.config.ts`

**Interfaces:**
- Produces: `@netra/observe/mastra` resolvable by consumers; `@mastra/core` optional peer (floor `^1.50.0` — `resolveCurrentSpan` and `ObservabilityExporter` verified present at the `@mastra/core@1.50.1` tag).

- [ ] **Step 1: Edit package.json**

Add top-level fields (after `"license"`), update `description`, and extend the peer sections:

```json
"description": "One-line LLM observability for Netra Runtime — Mastra and LangChain.js.",
"exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
    "./mastra": {
        "types": "./dist/mastra/index.d.ts",
        "import": "./dist/mastra/index.js"
    }
},
"files": ["dist"],
```

In `"peerDependencies"` add `"@mastra/core": "^1.50.0"`; in `"peerDependenciesMeta"` add `"@mastra/core": { "optional": true }`.

- [ ] **Step 2: Create tsup.config.ts**

```ts
import { defineConfig } from "tsup"

export default defineConfig({
    entry: { index: "src/index.ts", "mastra/index": "src/mastra/index.ts" },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
})
```

- [ ] **Step 3: Build, typecheck, test**

Run: `npm run build && npm run typecheck && npm test`
Expected: `dist/index.js`, `dist/index.d.ts`, `dist/mastra/index.js`, `dist/mastra/index.d.ts` produced; typecheck and tests PASS. (If `dts` fails on the pre-existing `require(...)` calls in `instrument.ts`, that is prior art unrelated to this task — report it, do not refactor instrument.ts here.)

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json tsup.config.ts
git commit -m "feat(js): package @netra/observe/mastra subpath; @mastra/core optional peer"
```

---

### Task 7: End-to-end test — one server plays gateway + collector

Proves the full loop with the real `NetraExporter`: the traceparent injected on the model call matches a span Mastra exported, and OTLP spans arrive at the endpoint with auth.

**Files:**
- Test: `js/test/mastra-e2e.test.ts`

**Interfaces:**
- Consumes: `NetraExporter` (Task 5) and `@mastra/core` public API. No new production code — if this test needs one, that's a finding to report, not to hack around.

- [ ] **Step 1: Write the test**

Create `js/test/mastra-e2e.test.ts`:

```ts
import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import type { IncomingHttpHeaders } from "node:http"
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core/mastra"
import { TracingEventType } from "@mastra/core/observability"
import type { AnyExportedSpan, TracingEvent } from "@mastra/core/observability"
import { NetraExporter } from "../src/mastra/index.js"

/** One host plays both Netra roles: OpenAI-compatible gateway
 * (/v1/chat/completions) and OTLP collector (/v1/traces). */
function mockNetra(): Promise<{
    port: number
    chat: IncomingHttpHeaders[]
    otlp: IncomingHttpHeaders[]
    close: () => void
}> {
    return new Promise((resolve) => {
        const chat: IncomingHttpHeaders[] = []
        const otlp: IncomingHttpHeaders[] = []
        const srv: Server = createServer((req, res) => {
            if (req.url?.endsWith("/v1/traces")) {
                otlp.push(req.headers)
                req.resume()
                req.on("end", () => res.writeHead(200).end())
                return
            }
            chat.push(req.headers)
            res.writeHead(200, { "content-type": "application/json" }).end(
                JSON.stringify({
                    id: "chatcmpl-e2e",
                    object: "chat.completion",
                    created: 0,
                    model: "test-model",
                    choices: [
                        {
                            index: 0,
                            message: { role: "assistant", content: "hi" },
                            finish_reason: "stop",
                        },
                    ],
                    usage: {
                        prompt_tokens: 1,
                        completion_tokens: 1,
                        total_tokens: 2,
                    },
                })
            )
        })
        srv.listen(0, "127.0.0.1", () => {
            const port = (srv.address() as { port: number }).port
            resolve({ port, chat, otlp, close: () => srv.close() })
        })
    })
}

let cleanup: (() => Promise<void>) | null = null
afterEach(async () => {
    await cleanup?.()
    cleanup = null
})

describe("mastra e2e: export + gateway join", () => {
    it("injected traceparent matches an exported span; OTLP arrives with auth", async () => {
        const netra = await mockNetra()

        const exporter = new NetraExporter({
            apiKey: "test-api-key",
            endpoint: `http://127.0.0.1:${netra.port}`,
        })
        cleanup = async () => {
            await exporter.shutdown()
            netra.close()
        }

        const ended: AnyExportedSpan[] = []
        const capture = {
            name: "capture",
            exportTracingEvent: async (e: TracingEvent) => {
                if (e.type === TracingEventType.SPAN_ENDED)
                    ended.push(e.exportedSpan)
            },
            flush: async () => {},
            shutdown: async () => {},
        }

        const agent = new Agent({
            name: "e2e",
            instructions: "Answer briefly.",
            model: {
                providerId: "netra",
                modelId: "test-model",
                url: `http://127.0.0.1:${netra.port}/v1`,
                apiKey: "test-key",
            },
        })
        const mastra = new Mastra({
            agents: { e2e: agent },
            observability: {
                configs: { netra: { exporters: [exporter, capture] } },
            },
        })

        await mastra.getAgent("e2e").generate("hello")
        await new Promise((r) => setTimeout(r, 200))

        // Join lane: the model call carried a traceparent…
        expect(netra.chat.length).toBeGreaterThan(0)
        const tp = netra.chat[0]["traceparent"] as string
        expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
        const [, traceId, spanId] = tp.split("-")

        // …whose ids belong to spans Mastra exported (same ids the
        // NetraExporter ships to OTLP — converter uses them verbatim).
        expect(ended.length).toBeGreaterThan(0)
        expect(ended.some((s) => s.traceId === traceId)).toBe(true)
        expect(ended.some((s) => s.id === spanId)).toBe(true)

        // Export lane: flushed OTLP batch reached /v1/traces with auth.
        await exporter.flush()
        expect(netra.otlp.length).toBeGreaterThan(0)
        expect(netra.otlp[0]["authorization"]).toBe("Bearer test-api-key")
    })
})
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/mastra-e2e.test.ts`
Expected: PASS. If `ended.some((s) => s.id === spanId)` fails while the traceId matches, the ambient span at fetch time is one Mastra does not export (e.g. an internal span) — re-check the Task 1 spike output, and if the spike's ambient span type is confirmed exported, debug before weakening the assertion. Weakening to traceId-only must be a deliberate, documented decision, not a green-making edit.

- [ ] **Step 3: Run the full suite**

Run: `npm test`
Expected: PASS — every suite.

- [ ] **Step 4: Commit**

```bash
git add test/mastra-e2e.test.ts
git commit -m "test(js): mastra e2e — traceparent joins exported trace; OTLP export with auth"
```

---

### Task 8: Example, README, FINDINGS update

**Files:**
- Create: `js/examples/mastra_agent.ts`
- Create: `js/README.md`
- Modify: `js/FINDINGS.md` (append one section)

- [ ] **Step 1: Write the example**

Create `js/examples/mastra_agent.ts`:

```ts
/**
 * Mastra + Netra observability — one touch point.
 *
 * Run:
 *   NETRA_API_KEY=nk_... OPENAI_API_KEY=sk-... npx tsx examples/mastra_agent.ts
 *
 * The NetraExporter ships every Mastra span (agent run, model generation,
 * tool calls) to Netra, and injects the live span's traceparent into model
 * calls routed through the Netra gateway so the gateway ledger row joins
 * the same trace.
 */
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core/mastra"
import { NetraExporter } from "../src/mastra/index.js"

const assistant = new Agent({
    name: "assistant",
    instructions: "Answer briefly.",
    // To route the model call through the Netra gateway (enabling the
    // trace join), point the model at it:
    // model: {
    //     providerId: "netra",
    //     modelId: "gpt-4o-mini",
    //     url: "https://api.netraruntime.com/v1",
    //     apiKey: process.env.NETRA_API_KEY!,
    // },
    model: "openai/gpt-4o-mini",
})

const mastra = new Mastra({
    agents: { assistant },
    observability: {
        configs: { netra: { exporters: [new NetraExporter()] } },
    },
})

const { text } = await mastra
    .getAgent("assistant")
    .generate("What is OpenTelemetry, in one sentence?")
console.log(text)
```

- [ ] **Step 2: Sanity-check the example compiles**

Run: `npx tsc --noEmit examples/mastra_agent.ts 2>&1 | head -5` — or simpler, confirm `npm run typecheck` still passes if the tsconfig includes `examples/`. If tsconfig excludes `examples/`, run: `npx tsx --tsconfig tsconfig.json -e "import('./examples/mastra_agent.ts')" 2>&1 | head -3` and expect only the missing-API-key runtime warning, not a type/module error. Do not actually call OpenAI.

- [ ] **Step 3: Write js/README.md**

```markdown
# @netra/observe

One-line LLM observability for [Netra Runtime](https://netraruntime.com).

## Mastra

```ts
import { Mastra } from "@mastra/core/mastra"
import { NetraExporter } from "@netra/observe/mastra"

export const mastra = new Mastra({
    agents: { myAgent },
    observability: {
        configs: { netra: { exporters: [new NetraExporter()] } },
    },
})
```

Set `NETRA_API_KEY` (and optionally `NETRA_OTEL_ENDPOINT`, `NETRA_PROJECT`,
`NETRA_ENVIRONMENT`), or pass them: `new NetraExporter({ apiKey, endpoint,
project, environment })`.

What you get:

- Every Mastra span (agent runs, model generations, tool calls, workflows)
  exported to Netra as OpenInference-conventioned OpenTelemetry spans.
- Model calls routed through the Netra gateway carry the live span's
  `traceparent`, so gateway-side records join the same trace. Route a model
  through the gateway with Mastra's custom-provider model config:

```ts
model: {
    providerId: "netra",
    modelId: "gpt-4o-mini",
    url: "https://api.netraruntime.com/v1",
    apiKey: process.env.NETRA_API_KEY!,
}
```

See `examples/mastra_agent.ts`.

## LangChain.js

Paused on an upstream ESM instrumentation blocker — status and the path
forward are documented in `FINDINGS.md`.
```

- [ ] **Step 4: Append to FINDINGS.md**

Append at the end of `js/FINDINGS.md`:

```markdown
## Update 2026-07-09: Mastra integration shipped

The Mastra path does not depend on the blocked OpenInference stack and is
live: `NetraExporter` (`@netra/observe/mastra`) receives spans through
Mastra's documented exporter interface and reads the ambient span via
`resolveCurrentSpan()` for the gateway join — no module patching, no
preload. Spec: `docs/superpowers/specs/2026-07-09-netra-observe-mastra-design.md`.
The LangChain.js blocker and its robust path forward above remain accurate.
```

- [ ] **Step 5: Full suite one last time, then commit**

Run: `npm test && npm run typecheck`
Expected: PASS.

```bash
git add examples/mastra_agent.ts README.md FINDINGS.md
git commit -m "docs(js): mastra example, README quickstart, FINDINGS update"
```
