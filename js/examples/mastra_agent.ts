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
import { Observability } from "@mastra/observability"
import { NetraExporter } from "../src/mastra/index.js"

const assistant = new Agent({
    id: "assistant",
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
    observability: new Observability({
        configs: {
            netra: {
                serviceName: "mastra-example",
                exporters: [new NetraExporter()],
            },
        },
    }),
})

const { text } = await mastra
    .getAgent("assistant")
    .generate("What is OpenTelemetry, in one sentence?")
console.log(text)
