"""
extract_info.py
Turns a list of call transcripts into a table:
conversation_id | hotel_name | hotel_address | final_price | reservation_number

Input: a list like
  [{"conversation_id": "abc", "transcript": "..."}, ...]
"transcript" can be one string, or ElevenLabs-style turns:
  [{"role": "agent", "message": "..."}, {"role": "user", "message": "..."}]
"""
import ast
import re

import anthropic
import pandas as pd
from dotenv import load_dotenv

load_dotenv()  # reads ANTHROPIC_API_KEY from .env
client = anthropic.Anthropic()
MODEL = "claude-haiku-5-5"

SYSTEM = """You extract facts from hotel phone call transcripts.
Rules:
- Use ONLY what is said in the transcript. Never guess or fill in.
- If a field is not clearly stated, return null.
- final_price: the LAST total price the hotel clearly confirmed.
  Ignore prices that were only asked about, mentioned as online prices, or later changed.
  If the call ended before a price was confirmed, return null.
- price_evidence: copy the exact words from the transcript where that price was confirmed."""

TOOL = {
    "name": "record_call_info",
    "description": "Record the facts found in one hotel call transcript.",
    "input_schema": {
        "type": "object",
        "properties": {
            "hotel_name": {"type": ["string", "null"]},
            "hotel_address": {"type": ["string", "null"]},
            "final_price": {
                "type": ["number", "null"],
                "description": "Final confirmed price as a number only, e.g. 450.00",
            },
            "reservation_number": {"type": ["string", "null"]},
            "price_evidence": {
                "type": ["string", "null"],
                "description": "Exact words copied from the transcript confirming the price",
            },
        },
        "required": ["hotel_name", "hotel_address", "final_price",
                     "reservation_number", "price_evidence"],
    },
}


def to_text(transcript):
    """Turn a transcript (string or list of turns) into one plain string."""
    if isinstance(transcript, str):
        return transcript
    lines = []
    for turn in transcript or []:
        role = turn.get("role", "?")
        msg = turn.get("message") or ""
        lines.append(f"{role}: {msg}")
    return "\n".join(lines)


def _norm(s):
    """Lowercase and squash spaces, so small formatting differences don't matter."""
    return re.sub(r"\s+", " ", s.lower()).strip()


def extract_one(conversation_id, transcript):
    """Ask the LLM to fill the form for ONE conversation."""
    text = to_text(transcript)
    row = {"conversation_id": conversation_id, "hotel_name": None,
           "hotel_address": None, "final_price": None, "reservation_number": None}

    if not text.strip():
        return row  # empty call -> all None

    resp = client.messages.create(
        model=MODEL,
        max_tokens=500,
        system=SYSTEM,
        tools=[TOOL],
        tool_choice={"type": "tool", "name": "record_call_info"},  # must fill the form
        messages=[{"role": "user", "content": f"<transcript>\n{text}\n</transcript>"}],
    )
    data = next(b.input for b in resp.content if b.type == "tool_use")

    # Anti-hallucination check: the price number must really appear in the transcript.
    price = data.get("final_price")
    if price is not None:
        num = str(int(price)) if float(price).is_integer() else str(price)
        if not re.search(rf"(?<!\d){re.escape(num)}(?!\d)", text.replace(",", "")):
            print(f"[{conversation_id}] rejected price {price}: not in transcript")
            data["final_price"] = None

    for key in ("hotel_name", "hotel_address", "final_price", "reservation_number"):
        row[key] = data.get(key)
    return row


def extract_all(conversations):
    """Main function: list of conversations in, table (DataFrame) out."""
    rows = []
    for conv in conversations:
        cid = conv.get("conversation_id")
        try:
            rows.append(extract_one(cid, conv.get("transcript")))
        except Exception as e:  # one bad call shouldn't break the whole table
            print(f"[{cid}] failed: {e}")
            rows.append({"conversation_id": cid, "hotel_name": None,
                         "hotel_address": None, "final_price": None,
                         "reservation_number": None})
    return pd.DataFrame(rows)


def parse_log(log_text):
    """Turn your raw 'Calling tool / Arguments / Tool output' log into a list of calls."""
    calls = []
    for block in log_text.split("Calling tool:")[1:]:
        args_m = re.search(r"Arguments:\s*(\{.*\})", block)
        out_m = re.search(r"Tool output:\s*(\{.*\})", block)
        if not out_m:
            continue
        try:
            args = ast.literal_eval(args_m.group(1)) if args_m else {}
            out = ast.literal_eval(out_m.group(1))  # it's a Python dict, not JSON
        except (ValueError, SyntaxError) as e:
            print(f"Could not parse a block: {e}")
            continue
        calls.append({
            "conversation_id": out.get("building_id") or args.get("building_id"),
            "company_name": out.get("company_name") or args.get("company_name"),
            "phone": args.get("phone_number"),
            "call_status": out.get("call_status"),
            "transcript": out.get("transcript", ""),
        })
    return calls


def extract_from_log(log_text):
    """Main entry for your log format: raw log text in, table out."""
    calls = parse_log(log_text)
    table = extract_all(calls)
    # Name and phone from the tool arguments are what we actually dialed: trust those.
    table["hotel_name"] = [c["company_name"] or n for c, n in zip(calls, table["hotel_name"])]
    table["phone"] = [c["phone"] for c in calls]
    table["call_status"] = [c["call_status"] for c in calls]
    return table


if __name__ == "__main__":
    fake = [
        {"conversation_id": "conv_1", "transcript": [
            {"role": "user", "message": "Thank you for calling the Maple Inn, 12 King Street West."},
            {"role": "agent", "message": "Hi, I'd like a room Dec 12 to 15. I saw $150 a night online."},
            {"role": "user", "message": "Online is 150, but for you I can do 420 total for three nights."},
            {"role": "agent", "message": "Great, please book it."},
            {"role": "user", "message": "Done. Your confirmation number is MX4471."},
        ]},
        {"conversation_id": "conv_2", "transcript": [
            {"role": "user", "message": "Lakeview Hotel, please hold."},
            {"role": "agent", "message": "Sure."},
        ]},  # hung up before any price -> final_price should be None
    ]
    print(extract_all(fake).to_string(index=False))
