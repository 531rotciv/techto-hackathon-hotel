import json
from pathlib import Path

# Loads tool definitions for the agent from a JSON file located in the tools directory.

ROOT = Path(__file__).resolve().parent.parent
TOOL_DEFINITIONS_PATH = ROOT / "tools" / "tool_descriptions.json"

with TOOL_DEFINITIONS_PATH.open("r", encoding="utf-8") as f:
    TOOL_DEFINITIONS = json.load(f)