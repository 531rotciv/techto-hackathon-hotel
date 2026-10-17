import requests
from tools.tool_parsing import TOOL_DEFINITIONS
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


agent = requests.post(
    f"{BASE_URL}/assistants",
    headers=HEADERS,
    json={
        "name": "Travel Agent",
        "system_prompt": TRAVEL_AGENT_SYSTEM_PROMPT,
    },
    tools=TOOL_DEFINITIONS,
)

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

query_response.raise_for_status()
result = query_response.json()
print(result["content"])
print("Created travel agent:", assistant_id)