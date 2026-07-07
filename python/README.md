# netra-observe

One-line LangChain observability for [Netra Runtime](https://netraruntime.com):
your agents, chains, tools, and LLM calls land as traces in the dashboard's
Usage tab, with cost and token numbers taken from the gateway's billing
ledger — never from client-side estimates.

## Install

```bash
pip install netra-observe
```

## Quickstart

```python
from netra_observe import instrument

instrument(api_key="sk_live_...", project="support-agent")
```

Call it once at startup, **before** building your chains. Everything
LangChain runs after that — agents, chains, tools, retrievers, LLM calls —
is traced automatically (via OpenInference's LangChain instrumentation) and
exported to Netra over OTLP.

Point your LLM at the Netra gateway as usual:

```python
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    model="qwen3.6-35b",
    base_url="https://api.netraruntime.com/v1",
    api_key="sk_live_...",  # same Netra key
)
```

See `examples/langchain_agent.py` for a runnable tool-calling agent.

## Configuration

| `instrument()` argument | Env fallback | Default |
| --- | --- | --- |
| `api_key` | `NETRA_API_KEY` | — (required) |
| `project` | `NETRA_PROJECT` | `None` |
| `environment` | `NETRA_ENVIRONMENT` | `None` |
| `endpoint` | `NETRA_OTEL_ENDPOINT` | `https://api.netraruntime.com/v1/otel` |
| `tracer_provider` | — | netra-observe creates one |

`instrument()` returns a handle: `handle.flush()` forces an export,
`handle.shutdown()` (or using the handle as a context manager) flushes and
detaches everything. Pass your own `tracer_provider` to attach Netra's
exporter setup to an existing OpenTelemetry deployment instead of letting
the SDK own one.

## How cost attribution works

The SDK propagates W3C trace context (`traceparent`) on HTTP requests to
the Netra gateway — **propagation only, it never starts spans of its own**.
The gateway records the trace/span id on its billing ledger row, so the LLM
span in your trace is joined server-side to the exact request the gateway
metered. Tokens and cost shown in the Usage tab come from that ledger;
client-reported numbers are never billed.

## Failure isolation

netra-observe must never break your app: export failures are logged and
dropped (spans are batched and sent in the background), header injection
degrades to "no header" on any error, and `shutdown()` caps its final flush
at 5 seconds.

## Known limitations (0.1.x)

- **Worker threads:** the LLM-run context that drives exact span attribution
  is a `ContextVar`; threads you spawn yourself (e.g. `ThreadPoolExecutor`)
  don't inherit it, so bare `llm.invoke()` calls made inside such threads
  fall back to trace-level (not span-exact) attribution. LangChain's own
  `batch()`/async paths propagate context correctly.
- **Existing OpenInference instrumentation (e.g. Phoenix):** if
  `LangChainInstrumentor` is already active, `instrument()` adds trace
  propagation but leaves span export with your existing setup; pass
  `tracer_provider=` to route spans through Netra as well. `shutdown()`
  never tears down instrumentation it didn't create.
- **Redirects:** `traceparent` is injected before the request is sent; if
  the gateway host redirects off-host, the header follows the redirect.
