import { describe, it, expect, afterEach } from "vitest"
import { createServer, type Server } from "node:http"
import { Agent } from "@mastra/core/agent"
import { Mastra } from "@mastra/core/mastra"
import { resolveCurrentSpan, TracingEventType } from "@mastra/core/observability"
import type { AnySpan, TracingEvent } from "@mastra/core/observability"
import { Observability } from "@mastra/observability"

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
            observability: new Observability({
                configs: {
                    capture: { serviceName: "capture", exporters: [capture] },
                },
            }),
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
