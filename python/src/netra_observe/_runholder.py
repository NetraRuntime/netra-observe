from __future__ import annotations

import logging
from contextvars import ContextVar
from typing import Any, Optional
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

logger = logging.getLogger("netra_observe")

# The chat-model/LLM run currently in flight in this execution context.
# get_current_span() (OpenInference) only resolves under a PARENT runnable —
# a bare llm.invoke() leaves LangChain's config contextvar unset, and inside
# chains it resolves to the surrounding chain's run, not the LLM's. Recording
# the run id at on_(chat_model|llm)_start gives the exact LLM run in both
# shapes; _inject looks the span up in OpenInference's registry at HTTP time.
_current_llm_run: ContextVar[Optional[UUID]] = ContextVar(
    "netra_current_llm_run", default=None
)

# register_configure_hook injects the handler held by this var into EVERY
# callback configure() — including bare invokes with no callbacks passed.
_holder_var: ContextVar[Optional["_RunHolder"]] = ContextVar(
    "netra_run_holder", default=None
)
_hook_registered = False


class _RunHolder(BaseCallbackHandler):
    """Records the in-flight LLM run id. run_inline keeps async dispatch in
    the caller's context so the ContextVar write is visible to the HTTP call."""

    run_inline = True

    def on_chat_model_start(self, serialized: Any, messages: Any, *, run_id: UUID, **kw: Any) -> None:
        _current_llm_run.set(run_id)

    def on_llm_start(self, serialized: Any, prompts: Any, *, run_id: UUID, **kw: Any) -> None:
        _current_llm_run.set(run_id)

    def on_llm_end(self, response: Any, *, run_id: UUID, **kw: Any) -> None:
        if _current_llm_run.get() == run_id:
            _current_llm_run.set(None)

    def on_llm_error(self, error: BaseException, *, run_id: UUID, **kw: Any) -> None:
        if _current_llm_run.get() == run_id:
            _current_llm_run.set(None)


def current_llm_run_id() -> Optional[UUID]:
    return _current_llm_run.get()


def activate() -> None:
    """Register the run-holder into LangChain's global callback configuration."""
    global _hook_registered
    if not _hook_registered:
        from langchain_core.tracers.context import register_configure_hook

        register_configure_hook(_holder_var, inheritable=True)
        _hook_registered = True
    _holder_var.set(_RunHolder())


def deactivate() -> None:
    _holder_var.set(None)
    _current_llm_run.set(None)
