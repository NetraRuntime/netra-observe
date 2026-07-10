export const DEFAULT_ENDPOINT = "https://api.netraruntime.com/v1/otel"

export class NetraConfigError extends Error {}

export interface NetraConfig {
    apiKey: string
    endpoint: string
    gatewayHost: string
    project?: string
    agent?: string
    environment?: string
}

export interface InstrumentOptions {
    apiKey?: string
    project?: string
    agent?: string
    environment?: string
    endpoint?: string
}

/** Lowercase the host and strip the scheme's default port so config-side and
 * request-side host comparisons agree. `scheme` is a URL protocol, with or
 * without the trailing colon. */
export function normalizeHost(netloc: string, scheme: string): string {
    let host = netloc.toLowerCase()
    const s = scheme.replace(/:$/, "")
    if (s === "https" && host.endsWith(":443")) host = host.slice(0, -4)
    else if (s === "http" && host.endsWith(":80")) host = host.slice(0, -3)
    return host
}

export function resolveConfig(opts: InstrumentOptions = {}): NetraConfig {
    const apiKey = opts.apiKey ?? process.env.NETRA_API_KEY
    if (!apiKey) {
        throw new NetraConfigError(
            "netra-observe needs an API key: pass instrument({ apiKey }) or set NETRA_API_KEY"
        )
    }
    const raw =
        opts.endpoint ?? process.env.NETRA_OTEL_ENDPOINT ?? DEFAULT_ENDPOINT
    const endpoint = raw.replace(/\/+$/, "")
    const u = new URL(endpoint)
    const gatewayHost = normalizeHost(u.host, u.protocol)
    if (!gatewayHost) {
        throw new NetraConfigError(`invalid OTLP endpoint: ${endpoint}`)
    }
    return {
        apiKey,
        endpoint,
        gatewayHost,
        project: opts.project ?? process.env.NETRA_PROJECT,
        agent: opts.agent ?? process.env.NETRA_AGENT,
        environment: opts.environment ?? process.env.NETRA_ENVIRONMENT,
    }
}
