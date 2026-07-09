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
    private installed = false
    private addedSource = false

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
        install(cfg.gatewayHost)
        this.installed = true
        addSpanContextSource(mastraSpanContext)
        this.addedSource = true
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

    async flush(timeoutMs = 5000): Promise<void> {
        try {
            if (this.processor) {
                await Promise.race([
                    this.processor.forceFlush(),
                    new Promise<void>((r) => setTimeout(r, timeoutMs)),
                ])
            }
        } catch (err) {
            diag.debug(
                `netra-observe: flush failed: ${(err as Error).message}`
            )
        }
    }

    async shutdown(timeoutMs = 5000): Promise<void> {
        if (this.addedSource) {
            removeSpanContextSource(mastraSpanContext)
            this.addedSource = false
        }
        if (this.installed) {
            uninstall()
            this.installed = false
        }
        try {
            if (this.processor) {
                await Promise.race([
                    this.processor.shutdown(),
                    new Promise<void>((r) => setTimeout(r, timeoutMs)),
                ])
            }
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
