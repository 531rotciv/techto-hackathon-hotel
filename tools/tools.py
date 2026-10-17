
import os
import time
import re
from decimal import Decimal, InvalidOperation
from typing import Any
import random

import requests


# Leave empty for now; populate through an environment variable later.
ELEVENLABS_API_KEY = "sk_efe218a91ffa4990c7e42e113d7c0add141256cbb75b7aaa"
ELEVENLABS_AGENT_ID = "agent_5201m55bhckqf8w92en2z6r7gvrt"
ELEVENLABS_PHONE_NUMBER_ID = "phnum_0001m55jxj5rejnthj88qvkyp386"





ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"
SERP_API_KEY = "47dae7cda7fda633a20d50337cd0b14a4597d46d74af13c7daddede295ca8cdb"
SERP_URL = "https://serpapi.com/search.json" 


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
    poll_interval_seconds: int = 5
):
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
                "call_id": random.randint(10000, 99999),
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
                    "call_status": "completed",
                    "transcript": transcript_text,
                }

            if last_status == "failed":
                return {
                    "building_id": building_id,
                    "company_name": company_name,
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




def _search(location, check_in, check_out, rentals=False, bedrooms=None):
   """Ask SerpApi for places. Hotels by default, rentals if rentals=True. 1 search."""
   params = {
       "engine": "google_hotels",
       "q": location,
       "check_in_date": check_in,
       "check_out_date": check_out,
       "currency": "USD",
       "api_key": SERP_API_KEY,
   }
   if rentals:
       params["vacation_rentals"] = "true"
       if bedrooms:
           params["bedrooms"] = bedrooms      # minimum bedrooms (rentals only)
   r = requests.get(SERP_URL, params=params, timeout=30)
   if r.status_code != 200:
       print("SerpApi says:", r.text)
   r.raise_for_status()
   return r.json().get("properties", [])




def _bedrooms(p):
   """Find the bedroom number in text like '2 bedrooms'. None if not found."""
   for item in p.get("essential_info", []):
       m = re.search(r"(\d+)\s+bedroom", item)
       if m:
           return int(m.group(1))
   return None




def _clean(p, check_in, check_out):
   """Keep only the fields we care about from one place."""
   return {
       "name": p.get("name"),
       "type": p.get("type"),
       "price_per_night": p.get("rate_per_night", {}).get("extracted_lowest"),
       "total_price": p.get("total_rate", {}).get("extracted_lowest"),
       "bedrooms": _bedrooms(p),
       "check_in": check_in,
       "check_out": check_out,
       "property_token": p.get("property_token"),
   }




def search_all(location, check_in, check_out, bedrooms=None):
   """Hotels + rentals in one list, no duplicates. 2 searches."""
   hotels = _search(location, check_in, check_out)
   rentals = _search(location, check_in, check_out, rentals=True, bedrooms=bedrooms)
   results, seen = [], set()
   for p in hotels + rentals:
       r = _clean(p, check_in, check_out)
       if r["property_token"] in seen:
           continue
       seen.add(r["property_token"])
       results.append(r)
   return results




def get_contact(property_token, check_in, check_out, location):
   """Phone + address for ONE place. 1 search."""
   params = {
       "engine": "google_hotels",
       "q": location,                         # SerpApi needs the search phrase too
       "property_token": property_token,
       "check_in_date": check_in,
       "check_out_date": check_out,
       "currency": "USD",
       "api_key": SERP_API_KEY,
   }
   r = requests.get(SERP_URL, params=params, timeout=30)
   if r.status_code != 200:
       print("SerpApi says:", r.text)
   r.raise_for_status()
   d = r.json()
   return {"phone": d.get("phone"), "address": d.get("address")}




def search_stays(city, start_date, end_date, bedrooms=None, how_many=2, max_lookups=6):
   """MAIN FUNCTION.
   Returns the `how_many` cheapest places that HAVE a phone number:
   [{name, type, price_per_night, total_price, phone, address}, ...]
   Usually ~3 SerpApi searches per call."""


   # 1. Search (hotels only unless bedrooms is given)
   if bedrooms:
       results = search_all(city, start_date, end_date, bedrooms)
   else:
       results = [_clean(p, start_date, end_date)
                  for p in _search(city, start_date, end_date)]


   # 2. Filter: needs a price + token; rentals must meet bedrooms
   candidates = [
       r for r in results
       if r["total_price"] is not None
       and r["property_token"]
       and (not bedrooms or r["bedrooms"] is None or r["bedrooms"] >= bedrooms)
   ]


   # 3. Sort: cheapest total price first
   candidates.sort(key=lambda r: r["total_price"])


   # 4. Look up phones cheapest-first, stop once we have enough
   found, lookups = [], 0
   for r in candidates:
       if len(found) == how_many or lookups == max_lookups:
           break
       try:
           contact = get_contact(r["property_token"], start_date, end_date, city)
       except Exception:
           continue
       finally:
           lookups += 1
       if contact["phone"]:
           found.append({
               "name": r["name"],
               "type": r["type"],
               "price_per_night": r["price_per_night"],
               "total_price": r["total_price"],
               "phone": contact["phone"],
               "address": contact["address"],
           })
   return found



   
import os
import smtplib
from decimal import Decimal, InvalidOperation
from email.message import EmailMessage


def send_quote_email(
    price: float,
    organization_name: str,
    organization_address: str,
    call_transcript_link: str,
    reservation_number: str|None = None
) -> dict:
    """
    Generate and send an email summarizing the cheapest accommodation quote.

    Args:
        price: Total quoted price for the stay.
        organization_name: Organization that provided the quote.

    Returns:
        A dictionary indicating whether the email was sent.
    """

    recipient = "kevinsbryce@gmail.com"
    sender = "kevinsbryce@gmail.com"
    smtp_password = "kdrh tgjw eqyn uaep"
    smtp_host = os.getenv("SMTP_HOST", "smtp.gmail.com")
    smtp_port = int(os.getenv("SMTP_PORT", "465"))
    currency = os.getenv("QUOTE_CURRENCY", "CAD")

    if not organization_name.strip():
        raise ValueError("Organization name cannot be empty.")

    try:
        quote = Decimal(str(price))
    except InvalidOperation as exc:
        raise ValueError("Price must be a valid number.") from exc

    if not quote.is_finite() or quote < 0:
        raise ValueError("Price must be a finite, non-negative number.")

    formatted_price = f"{currency} {quote:,.2f}"

    # Generate the email.
    message = EmailMessage()
    message["Subject"] = (
        f"Cheapest Accommodation Quote: {organization_name}"
    )
    message["From"] = sender
    message["To"] = recipient

    message.set_content(
        f"""Hello,

Team 13 compared accommodation options and identified the following quote
as the lowest qualifying price.

Organization: {organization_name}
Total quoted price: {formatted_price}
Hotel address: {address}
Link to call transcript: {call_link}
Reservation number: {reservation_number}

Please note that this price should be confirmed with the organization
before making a booking.

Best regards,
Travel Agent
"""
    )

    # Send the email using SMTP over SSL.
    try:
        with smtplib.SMTP_SSL(
            smtp_host,
            smtp_port,
            timeout=30,
        ) as server:
            server.login(sender, smtp_password)
            server.send_message(message)

        return {
            "success": True,
            "recipient": recipient,
            "organization_name": organization_name,
            "price": str(quote),
            "currency": currency,
            "message": "Quote email sent successfully.",
        }

    except (smtplib.SMTPException, OSError) as exc:
        return {
            "success": False,
            "recipient": recipient,
            "organization_name": organization_name,
            "error": str(exc),
        }
