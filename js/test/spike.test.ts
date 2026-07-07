import { describe, it, expect } from "vitest"
import { createServer, type Server } from "node:http"
import { createRequire } from "node:module"
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"
import {
    InMemorySpanExporter,
    SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { OpenAIInstrumentation } from "@arizeai/openinference-instrumentation-openai"

import { activeSpanContext } from "../src/context.js"

const require = createRequire(import.meta.url)

/**
 * The make-or-break proof: an instrumented OpenAI call to the "gateway"
 * carries a traceparent injected from the ACTIVE span, and that span is a
 * real exported OpenInference LLM span. This is the whole reason the SDK
 * works — if it breaks (e.g. an OpenInference bump stops making the span
 * active), this test fails loudly.
 */
describe("propagation spike (active-span injection)", () => {
    it("injects the in-flight LLM span's traceparent for the gateway host", async () => {
        const exporter = new InMemorySpanExporter()
        const provider = new NodeTracerProvider({
            spanProcessors: [new SimpleSpanProcessor(exporter)],
        })
        provider.register()
        registerInstrumentations({
            instrumentations: [new OpenAIInstrumentation()],
            tracerProvider: provider,
        })

        const got: Record<string, string | string[] | undefined>[] = []
        const srv: Server = createServer((req, res) => {
            got.push(req.headers)
            res.writeHead(200, { "content-type": "application/json" })
            res.end(
                JSON.stringify({
                    id: "x",
                    object: "chat.completion",
                    model: "gpt-4o",
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
        await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()))
        const host = `127.0.0.1:${(srv.address() as { port: number }).port}`

        const orig = globalThis.fetch
        globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
            try {
                const url = new URL(
                    typeof input === "string"
                        ? input
                        : input instanceof URL
                          ? input.href
                          : (input as Request).url
                )
                if (url.host === host) {
                    const sc = activeSpanContext()
                    if (sc) {
                        const headers = new Headers(
                            init?.headers ??
                                (input instanceof Request
                                    ? input.headers
                                    : undefined)
                        )
                        headers.set(
                            "traceparent",
                            `00-${sc.traceId}-${sc.spanId}-01`
                        )
                        return orig(input, { ...init, headers })
                    }
                }
            } catch {
                /* fall through */
            }
            return orig(input, init)
        }) as typeof globalThis.fetch

        try {
            const OpenAI = require("openai")
            const client = new OpenAI({
                apiKey: "sk-test",
                baseURL: `http://${host}/v1`,
            })
            await client.chat.completions.create({
                model: "gpt-4o",
                messages: [{ role: "user", content: "hi" }],
            })
        } finally {
            globalThis.fetch = orig
            srv.close()
        }

        const tp = got[0]?.["traceparent"] as string | undefined
        expect(tp).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/)
        const spanId = tp!.split("-")[2]
        const matched = exporter
            .getFinishedSpans()
            .some((s) => s.spanContext().spanId === spanId)
        expect(matched).toBe(true)
    })
})
