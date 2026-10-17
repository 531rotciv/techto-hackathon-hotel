
import json
import re
from typing import Any, Callable
from tools.tools import *

def execute_tool_call(
    tool_call: dict[str, Any],
    tool_map: dict[str, Callable[..., Any]],
) -> Any:
    """Execute a tool requested by the model."""

    tool_name = tool_call["name"]
    arguments = tool_call.get("arguments", {})

    print("Executing tool:", tool_name)
    print("Arguments:", arguments)

    tool = tool_map.get(tool_name)

    if tool is None:
        raise ValueError(f"Unknown tool requested: {tool_name}")

    # Some models return arguments as a JSON string rather than a dict.
    if isinstance(arguments, str):
        try:
            arguments = json.loads(arguments)
        except json.JSONDecodeError as exc:
            raise ValueError(
                f"Invalid JSON arguments for tool {tool_name}"
            ) from exc

    if not isinstance(arguments, dict):
        raise ValueError(
            f"Arguments for {tool_name} must be a dictionary"
        )

    return tool(**arguments)


def extract_tool_calls(response: str) -> list[dict[str, Any]]:
    """Extract tool calls from the model's response."""

    if not response:
        return []

    pattern = r"<tool_call>\s*(.*?)\s*</tool_call>"
    matches = re.findall(pattern, response, re.DOTALL)

    tool_calls = []

    for match in matches:
        try:
            parsed = json.loads(match)
        except json.JSONDecodeError:
            continue

        if not isinstance(parsed, dict):
            continue

        name = parsed.get("name")
        if not isinstance(name, str) or not name:
            continue

        arguments = parsed.get("arguments", {})

        # Validate arguments before adding the tool call.
        if isinstance(arguments, str):
            try:
                arguments = json.loads(arguments)
            except json.JSONDecodeError:
                continue

        if not isinstance(arguments, dict):
            continue

        tool_calls.append({
            "name": name,
            "arguments": arguments,
        })

    return tool_calls
