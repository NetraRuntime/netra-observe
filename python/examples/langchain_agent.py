"""Weather agent traced into Netra.

Run:  NETRA_API_KEY=sk_live_... python examples/langchain_agent.py
The LLM calls go through Netra's gateway; the whole run lands as one
trace in the dashboard's Usage tab.
"""
from __future__ import annotations

import os

from langchain_core.tools import tool
from langchain_openai import ChatOpenAI

from netra_observe import instrument

handle = instrument(project="weather-agent-example", environment="dev")


@tool
def get_weather(city: str) -> str:
    """Get the current weather for a city."""
    return f"22°C and sunny in {city}"


llm = ChatOpenAI(
    model=os.environ.get("NETRA_MODEL", "qwen3.6-35b"),
    base_url="https://api.netraruntime.com/v1",
    api_key=os.environ["NETRA_API_KEY"],
).bind_tools([get_weather])

msg = llm.invoke("What's the weather in Jakarta?")
for call in msg.tool_calls:
    print("tool call:", call["name"], call["args"])

handle.shutdown()  # flush before exit
