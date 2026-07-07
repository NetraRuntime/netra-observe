"""Multi-turn agentic flow e2e: one trace, several LLM turns + tool runs.

A manual ReAct-style loop wrapped in a named RunnableLambda so every turn
(chat call) and every tool execution nests under ONE chain root — the
grouped Usage table should show a single trace with llm_count >= 2 and
tool_count >= 2.
"""
from __future__ import annotations

import json
import os

from langchain_core.messages import HumanMessage, SystemMessage
from langchain_core.runnables import RunnableLambda
from langchain_core.tools import tool

from netra_observe import instrument

handle = instrument(project="multi-turn-agent", environment="e2e")


@tool
def get_weather(city: str) -> str:
    """Current weather for a city."""
    data = {"jakarta": "31°C, humid, scattered clouds", "bandung": "24°C, light rain"}
    return data.get(city.lower(), f"no data for {city}")


@tool
def calculator(expression: str) -> str:
    """Evaluate a basic arithmetic expression, e.g. '31 - 24'."""
    allowed = set("0123456789+-*/(). ")
    if not set(expression) <= allowed:
        return "invalid expression"
    return str(eval(expression))  # noqa: S307 - charset-restricted above


TOOLS = {t.name: t for t in (get_weather, calculator)}

from langchain_openai import ChatOpenAI  # noqa: E402

llm = ChatOpenAI(
    model=os.environ.get("NETRA_MODEL", "qwen3.6-35b"),
    base_url="https://api.netraruntime.com/v1",
    api_key=os.environ["NETRA_API_KEY"],
).bind_tools(list(TOOLS.values()))


def agent_loop(question: str) -> str:
    messages = [
        SystemMessage(
            "You are a precise assistant. Use the tools for weather lookups "
            "and arithmetic — never guess. Call ONE tool at a time."
        ),
        HumanMessage(question),
    ]
    for turn in range(8):
        ai = llm.invoke(messages)
        messages.append(ai)
        if not ai.tool_calls:
            return ai.content or "(empty)"
        for tc in ai.tool_calls:
            print(f"turn {turn + 1}: tool {tc['name']}({json.dumps(tc['args'])})")
            messages.append(TOOLS[tc["name"]].invoke(tc))
    return "(max turns reached)"


answer = RunnableLambda(agent_loop, name="weather comparison agent").invoke(
    "How much warmer is Jakarta than Bandung right now, in °C? "
    "Look up both cities, then compute the difference."
)
print("ANSWER:", answer)
handle.shutdown()
