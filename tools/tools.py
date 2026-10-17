
import os
import time
import re
from decimal import Decimal, InvalidOperation
from typing import Any

import requests


# Leave empty for now; populate through an environment variable later.
ELEVENLABS_API_KEY = ""
ELEVENLABS_AGENT_ID = ""
ELEVENLABS_PHONE_NUMBER_ID = ""

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"


def _elevenlabs_headers() -> dict[str, str]:
    api_key = os.getenv("ELEVENLABS_API_KEY") or ELEVENLABS_API_KEY

    if not api_key:
        raise RuntimeError("ElevenLabs API key is not configured.")

    return {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
    }


def call_accommodation(
    building_id: str,
    company_name: str,
    phone_number: str,
    start_date: str,
    end_date: str,
    guest_count: int,
    timeout_seconds: int = 180,
    poll_interval_seconds: int = 5,
) -> dict[str, Any]:
    """
    Call an accommodation and return its transcript.

    Requires a configured ElevenLabs agent and an outbound-enabled
    phone number. Returns a structured result on success or failure.
    """

    if not ELEVENLABS_AGENT_ID or not ELEVENLABS_PHONE_NUMBER_ID:
        return {
            "building_id": building_id,
            "company_name": company_name,
            "call_status": "failed",
            "error": "ElevenLabs agent ID or phone number ID is missing.",
            "transcript": None,
        }

    if guest_count < 1:
        return {
            "building_id": building_id,
            "company_name": company_name,
            "call_status": "failed",
            "error": "guest_count must be at least 1.",
            "transcript": None,
        }

    headers = _elevenlabs_headers()

    # Initiate the outbound call.
    call_payload = {
        "agent_id": ELEVENLABS_AGENT_ID,
        "agent_phone_number_id": ELEVENLABS_PHONE_NUMBER_ID,
        "to_number": phone_number,
        "conversation_initiation_client_data": {
            "dynamic_variables": {
                "company_name": company_name,
                "building_id": building_id,
                "start_date": start_date,
                "end_date": end_date,
                "guest_count": str(guest_count),
            }
        },
    }

    try:
        response = requests.post(
            f"{ELEVENLABS_BASE_URL}/convai/twilio/outbound-call",
            headers=headers,
            json=call_payload,
            timeout=30,
        )
        response.raise_for_status()
        call_data = response.json()

        conversation_id = call_data.get("conversation_id")

        if not conversation_id:
            return {
                "building_id": building_id,
                "company_name": company_name,
                "call_status": "failed",
                "error": "ElevenLabs did not return a conversation ID.",
                "provider_response": call_data,
                "transcript": None,
            }

        # Poll the conversation endpoint until processing is complete.
        deadline = time.monotonic() + timeout_seconds
        last_status = "initiated"

        while time.monotonic() < deadline:
            detail_response = requests.get(
                f"{ELEVENLABS_BASE_URL}/convai/conversations/"
                f"{conversation_id}",
                headers=headers,
                timeout=30,
            )
            detail_response.raise_for_status()
            detail = detail_response.json()

            last_status = detail.get("status", "unknown")

            if last_status == "done":
                transcript_items = detail.get("transcript", [])
                transcript_text = "\n".join(
                    f"{item.get('role', 'unknown')}: "
                    f"{item.get('message', '')}"
                    for item in transcript_items
                    if item.get("message")
                )

                return {
                    "building_id": building_id,
                    "company_name": company_name,
                    "call_id": conversation_id,
                    "call_status": "completed",
                    "transcript": transcript_text,
                }

            if last_status == "failed":
                return {
                    "building_id": building_id,
                    "company_name": company_name,
                    "call_id": conversation_id,
                    "call_status": "failed",
                    "error": "ElevenLabs reported that the call failed.",
                    "transcript": None,
                }

            time.sleep(poll_interval_seconds)

        return {
            "building_id": building_id,
            "company_name": company_name,
            "call_id": conversation_id,
            "call_status": "timeout",
            "error": (
                "Call transcript was not ready before the polling timeout. "
                "Use call_id to retrieve it later."
            ),
            "transcript": None,
            "last_provider_status": last_status,
        }

    except requests.RequestException as exc:
        return {
            "building_id": building_id,
            "company_name": company_name,
            "call_status": "failed",
            "error": f"ElevenLabs API request failed: {exc}",
            "transcript": None,
        }


def extract_lowest_quote(
    transcripts: list[dict[str, Any]],
    start_date: str,
    end_date: str,
) -> dict[str, Any]:
    """
    Extract explicit monetary quotes from call transcripts and
    return the lowest comparable total price.

    This is a deterministic baseline, not a full natural-language
    understanding system. It intentionally ignores ambiguous quotes.
    """

    # Matches amounts such as $450, CAD 450.00, or USD 450.
    money_pattern = re.compile(
        r"(?:(CAD|USD|EUR|GBP|AUD|C\$|US\$)\s*)?"
        r"(\$|€|£)?\s*"
        r"(\d{1,7}(?:,\d{3})*(?:\.\d{1,2})?)",
        re.IGNORECASE,
    )

    # Only treat a price as a total if the surrounding text indicates
    # that it covers the stay, rather than one night or one guest.
    total_keywords = (
        "total",
        "entire stay",
        "whole stay",
        "for the stay",
        "for your stay",
        "all in",
        "all-inclusive",
        "overall cost",
    )

    excluded_keywords = (
        "per night",
        "a night",
        "per person",
        "per guest",
        "nightly rate",
        "deposit",
        "starting at",
        "from $",
    )

    candidates = []
    rejected = []

    for call in transcripts:
        company = call.get("company_name", "Unknown company")
        building_id = call.get("building_id")
        call_id = call.get("call_id")
        status = call.get("call_status", "unknown")
        transcript = call.get("transcript") or ""

        if status != "completed" or not transcript.strip():
            rejected.append({
                "company_name": company,
                "reason": f"Call status is {status}, or transcript is missing.",
            })
            continue

        lines = transcript.splitlines()
        found_for_call = False

        for line in lines:
            lower_line = line.lower()

            if any(keyword in lower_line for keyword in excluded_keywords):
                continue

            if not any(keyword in lower_line for keyword in total_keywords):
                continue

            matches = list(money_pattern.finditer(line))

            if not matches:
                continue

            # Avoid interpreting a range or multiple amounts on the
            # same line as a single definitive quote.
            if len(matches) != 1:
                continue

            match = matches[0]
            currency_code = match.group(1)
            currency_symbol = match.group(2)
            amount_text = match.group(3).replace(",", "")

            if currency_code:
                currency = currency_code.upper()
                if currency == "C$":
                    currency = "CAD"
                elif currency == "US$":
                    currency = "USD"
            elif currency_symbol == "$":
                # A bare dollar sign does not establish CAD vs USD.
                currency = None
            elif currency_symbol == "€":
                currency = "EUR"
            elif currency_symbol == "£":
                currency = "GBP"
            else:
                currency = None

            try:
                amount = Decimal(amount_text)
            except InvalidOperation:
                continue

            if amount <= 0:
                continue

            candidates.append({
                "building_id": building_id,
                "company_name": company,
                "call_id": call_id,
                "quoted_price": float(amount),
                "currency": currency,
                "start_date": start_date,
                "end_date": end_date,
                "evidence": line.strip(),
            })
            found_for_call = True

        if not found_for_call:
            rejected.append({
                "company_name": company,
                "reason": (
                    "No unambiguous total-stay quote was found by "
                    "the deterministic extractor."
                ),
            })

    if not candidates:
        return {
            "status": "no_comparable_quotes",
            "start_date": start_date,
            "end_date": end_date,
            "lowest_quote": None,
            "rejected_calls": rejected,
        }

    # Never compare prices in different currencies without conversion.
    currencies = {item["currency"] for item in candidates}

    if None in currencies or len(currencies) != 1:
        return {
            "status": "currency_comparison_required",
            "start_date": start_date,
            "end_date": end_date,
            "lowest_quote": None,
            "candidate_quotes": candidates,
            "rejected_calls": rejected,
            "message": (
                "Quotes have missing or differing currencies. "
                "Confirm currencies and convert before ranking."
            ),
        }

    lowest = min(candidates, key=lambda item: item["quoted_price"])

    return {
        "status": "success",
        "start_date": start_date,
        "end_date": end_date,
        "lowest_quote": lowest,
        "quotes_considered": len(candidates),
        "rejected_calls": rejected,
    }
