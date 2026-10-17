import requests
from tools.tool_parsing import TOOL_DEFINITIONS
from tool_caller.tool_calls import *
import tools.tools as tools

API_KEY = "espr_RRoeSgg6wBeb7TW2CYK-aLfwdNJ4ORCNZ0fksPUslsE"
BASE_URL = "https://app.backboard.io/api"
HEADERS = {"X-API-Key": API_KEY, "Content-Type": "application/json"}

TRAVEL_AGENT_SYSTEM_PROMPT = """
You are an Travel agent   trying to find the cheapest stays in a city that the user provides.
Your task is to  search the internet using provided apis to find the 50 least expensive places to stay
in the city that the user asks you about. Once you have identified candidates, you will use 11labs API to 
call the top 10 candidates and inquire about booking a stay with them.  

You will take the transcripts of the calls provided by the 11labs api and identify the lowest quoted price
along with which company provided that quote. You will then generate an email summarizing the results of the 
call that contained the lowest quoted price and send the email. 
If any of the tools fails, identify which one failed and say that you were unable to complete the process.
"""
tool_map = {
            "search_stays": tools.search_stays,
            "call_accommodation": tools.call_accommodation,
            "extract_lowest_quote": tools.extract_lowest_quote
        }

agent = requests.post(
    f"{BASE_URL}/assistants",
    headers=HEADERS,
    json={
        "name": "Travel Agent",
        "system_prompt": TRAVEL_AGENT_SYSTEM_PROMPT,
        "tools": TOOL_DEFINITIONS,
    }
)

agent.raise_for_status()
assistant = agent.json()
assistant_id = assistant["assistant_id"]
print("do you make it here?")

agent.raise_for_status()
assistant = agent.json()
assistant_id = assistant["assistant_id"]

query_response = requests.post(
    f"{BASE_URL}/threads/messages",
    headers=HEADERS,
    json={
        "assistant_id": assistant_id,
        "content": "Find the cheapest places to stay in Toronto.",
    },
)
result = query_response.json()
# query_response.raise_for_status()
# result = query_response.json()
# print(result["content"])
# print("Created travel agent:", assistant_id)



thread_id = result["thread_id"]
print("Created travel agent:", assistant_id)
print("Thread ID:", thread_id)

MAX_ROUNDS = 15

for round_number in range(MAX_ROUNDS):
    print(f"\n--- Agent round {round_number + 1} ---")
    print("Status:", result.get("status"))

    # The model has finished.
    if result.get("status") == "COMPLETED":
        print("\nFINAL ANSWER:")
        print(result.get("content") or "")
        break

    if result.get("status") == "FAILED":
        raise RuntimeError(f"Backboard run failed: {result}")

    # The model wants us to execute tools.
    if result.get("status") != "REQUIRES_ACTION":
        raise RuntimeError(
            f"Unexpected status: {result.get('status')}. "
            f"Full response: {result}"
        )

    tool_calls = result.get("tool_calls", [])

    if not tool_calls:
        raise RuntimeError("No tool calls found in REQUIRES_ACTION response.")

    tool_outputs = []

    for tool_call in tool_calls:
        function = tool_call["function"]
        tool_name = function["name"]
        arguments = function["arguments"]

        if isinstance(arguments, str):
            arguments = json.loads(arguments)

        print(f"\nCalling tool: {tool_name}")
        print("Arguments:", arguments)

        try:
            tool = tool_map.get(tool_name)

            if tool is None:
                raise ValueError(f"Unknown tool: {tool_name}")

            output = tool(**arguments)

        except Exception as exc:
            output = {
                "success": False,
                "tool": tool_name,
                "error": str(exc),
            }

        print("Tool output:", output)

        tool_outputs.append({
            "tool_call_id": tool_call["id"],
            "output": json.dumps(output, default=str),
        })

    # Send results back so Backboard can continue reasoning.
    continuation = requests.post(
        f"{BASE_URL}/threads/tool-outputs",
        headers=HEADERS,
        json={
            "thread_id": thread_id,
            "tool_outputs": tool_outputs,
        },
        timeout=120,
    )

    continuation.raise_for_status()
    result = continuation.json()

else:
    raise RuntimeError(
        f"Agent did not finish within {MAX_ROUNDS} rounds."
    )
