import { diag } from "@opentelemetry/api"
import {
    registerInstrumentations,
    type Instrumentation,
} from "@opentelemetry/instrumentation"
import type { NodeTracerProvider } from "@opentelemetry/sdk-trace-node"

import { resolveConfig, type InstrumentOptions } from "./config.js"
import { buildProvider } from "./provider.js"
import { install, uninstall } from "./inject.js"

export const VERSION = "0.1.0"

export type InstrumentArgs = InstrumentOptions

export interface NetraInstrumentation {
    provider: NodeTracerProvider
    flush(timeoutMs?: number): Promise<void>
    shutdown(): Promise<void>
    [Symbol.asyncDispose](): Promise<void>
}

let active: NetraInstrumentation | null = null

/** Lazily construct an OpenInference instrumentation; skip (with one debug
 * log) when its optional peer isn't installed. The instrumentation making the
 * LLM call's span active is what the fetch patch reads. */
function tryInstrumentation(
    load: () => Instrumentation
): Instrumentation | null {
    try {
        return load()
    } catch (err) {
        diag.debug(
            `netra-observe: skipping an instrumentation (peer not installed): ${
                (err as Error).message
            }`
        )
        return null
    }
}

/** Wire tracing into the process. Idempotent; never throws after config
 * validation. Call this BEFORE importing your LLM SDKs so their modules get
 * instrumented, and before your first LLM call.
 *
 * v1 owns the OpenTelemetry setup: it builds a provider, registers it (which
 * installs the async context manager the active-span propagation depends on),
 * and registers the OpenInference LangChain/OpenAI/Anthropic instrumentations.
 * Bringing your own provider is not supported in v1 — OTel-JS v2 can't attach
 * a processor to an existing provider, and we need to own the global context
 * manager. */
export function instrument(args: InstrumentArgs = {}): NetraInstrumentation {
    if (active) return active

    const cfg = resolveConfig(args)
    const provider = buildProvider(cfg)
    // register() installs the global provider, the AsyncHooksContextManager
    // (so context.active() tracks spans across async — the mechanism), and the
    // W3C propagator.
    try {
        provider.register()
    } catch (err) {
        diag.debug(
            `netra-observe: provider.register() warned: ${(err as Error).message}`
        )
    }

    const instrumentations = [
        tryInstrumentation(() => {
            const {
                LangChainInstrumentation,
            } = require("@arizeai/openinference-instrumentation-langchain")
            const inst = new LangChainInstrumentation()
            const cm = require("@langchain/core/callbacks/manager")
            inst.manuallyInstrument(cm)
            return inst
        }),
        tryInstrumentation(() => {
            const {
                OpenAIInstrumentation,
            } = require("@arizeai/openinference-instrumentation-openai")
            return new OpenAIInstrumentation()
        }),
        tryInstrumentation(() => {
            const {
                AnthropicInstrumentation,
            } = require("@arizeai/openinference-instrumentation-anthropic")
            return new AnthropicInstrumentation()
        }),
    ].filter((i): i is Instrumentation => i != null)

    const disable = registerInstrumentations({
        instrumentations,
        tracerProvider: provider,
    })

    install(cfg.gatewayHost)

    active = {
        provider,
        async flush(timeoutMs = 5000): Promise<void> {
            try {
                await Promise.race([
                    provider.forceFlush(),
                    new Promise<void>((r) => setTimeout(r, timeoutMs)),
                ])
            } catch (err) {
                diag.debug(
                    `netra-observe: flush failed: ${(err as Error).message}`
                )
            }
        },
        async shutdown(): Promise<void> {
            try {
                disable()
            } catch {
                /* ignore */
            }
            uninstall()
            await this.flush()
            try {
                await provider.shutdown()
            } catch (err) {
                diag.debug(
                    `netra-observe: provider shutdown failed: ${
                        (err as Error).message
                    }`
                )
            }
            active = null
        },
        async [Symbol.asyncDispose](): Promise<void> {
            await this.shutdown()
        },
    }
    return active
}
