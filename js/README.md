# @netra/observe

One-line LLM observability for [Netra Runtime](https://netraruntime.com).

## Mastra

```ts
import { Mastra } from "@mastra/core/mastra"
import { Observability } from "@mastra/observability"
import { NetraExporter } from "@netra/observe/mastra"

export const mastra = new Mastra({
    agents: { myAgent },
    observability: new Observability({
        configs: {
            netra: {
                serviceName: "my-service",
                exporters: [new NetraExporter()],
            },
        },
    }),
})
```

Requires the `@mastra/observability` package (alongside `@mastra/core`).

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
