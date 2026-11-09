#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "httpx>=0.27",
#   "ddgs>=9.0",
#   "camoufox>=0.4",
#   "markdownify>=0.13",
# ]
# ///
"""Web search and page extraction CLI.

Providers (no silent fallback; a failure exits non-zero):
  openai-codex  ChatGPT subscription via the Codex backend's built-in web_search
                tool (default). Uses the existing login in ~/.codex/auth.json
                (`codex login`) or ~/.pi/agent/auth.json (pi `/login`).
  ddgs          DuckDuckGo et al. via the `ddgs` library; extract fetches the page.
  camoufox      Extract only: renders the page in the Camoufox browser
                (first run: `uvx camoufox fetch`).

Usage:
  web-search-and-extract.py search  [opts] -- "query"
  web-search-and-extract.py extract [opts] -- https://example.com/page
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import time
import uuid
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

CODEX_URL = "https://chatgpt.com/backend-api/codex/responses"
DEFAULT_MODEL = os.environ.get("WSX_CODEX_MODEL", "gpt-6.1-terra")
DEFAULT_EFFORT = os.environ.get("WSX_CODEX_EFFORT", "low")
TIMELIMITS = {"d": "the past day", "w": "the past week", "m": "the past month", "y": "the past year"}


class CliError(Exception):
    pass


# --------------------------------------------------------------------------- utils

def cap(text: str, limit: int) -> str:
    text = text.strip()
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + f"\n\n[Content truncated at {limit} characters.]"


def clean_url(url: str) -> str:
    """Drop tracking params the backend appends (utm_*, trk)."""
    try:
        parts = urlsplit(url)
        q = [(k, v) for k, v in parse_qsl(parts.query, keep_blank_values=True)
             if not k.startswith("utm_") and k != "trk"]
        return urlunsplit(parts._replace(query=urlencode(q)))
    except ValueError:
        return url


def clean_links(text: str) -> str:
    return re.sub(r"https?://[^\s)\]>]+", lambda m: clean_url(m.group(0)), text)


def clip(text: str, limit: int = 400) -> str:
    text = " ".join(text.split())
    return text if len(text) <= limit else text[:limit].rsplit(" ", 1)[0] + "…"


# ------------------------------------------------------------------- codex auth

def _jwt_payload(token: str) -> dict:
    try:
        seg = token.split(".")[1]
        return json.loads(base64.urlsafe_b64decode(seg + "=" * (-len(seg) % 4)))
    except Exception:
        return {}


def _candidates():
    codex_home = Path(os.environ.get("CODEX_HOME", Path.home() / ".codex"))
    try:
        tokens = json.loads((codex_home / "auth.json").read_text()).get("tokens") or {}
        if tokens.get("access_token"):
            yield "codex", tokens["access_token"], tokens.get("account_id")
    except (OSError, ValueError):
        pass
    pi_dir = Path(os.environ.get("PI_CODING_AGENT_DIR", Path.home() / ".pi/agent"))
    try:
        data = json.loads((pi_dir / "auth.json").read_text())
        for key in ("openai-codex", "openai"):
            cred = data.get(key) or {}
            if cred.get("type") == "oauth" or cred.get("access"):
                if cred.get("access"):
                    yield f"pi:{key}", cred["access"], cred.get("accountId")
    except (OSError, ValueError):
        pass


def codex_credentials() -> tuple[str, str]:
    """Return (access_token, account_id) from the first unexpired login. Never refreshes
    (refreshing would rotate the refresh token out from under Codex/pi)."""
    seen = []
    for source, token, account in _candidates():
        payload = _jwt_payload(token)
        account = account or (payload.get("https://api.openai.com/auth") or {}).get("chatgpt_account_id")
        exp = payload.get("exp", 0)
        if not account:
            seen.append(f"{source}: no ChatGPT account id")
        elif exp and exp < time.time() + 60:
            seen.append(f"{source}: token expired")
        else:
            return token, account
    detail = "; ".join(seen) or "no ChatGPT login found"
    raise CliError(f"No usable ChatGPT subscription login ({detail}). "
                   "Run `codex login` or pi `/login` (openai-codex), then retry.")


# ------------------------------------------------------------------- codex call

def codex_respond(prompt: str, instructions: str, args) -> tuple[str, list[dict], list[str]]:
    import httpx

    token, account = codex_credentials()
    body = {
        "model": args.model,
        "store": False,
        "stream": True,
        "instructions": instructions,
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": prompt}]}],
        "tools": [{"type": "web_search"}],
        "tool_choice": "required",
        "parallel_tool_calls": True,
        "reasoning": {"effort": args.effort},
        "text": {"verbosity": "medium"},
        "include": [],
    }
    session = str(uuid.uuid4())
    headers = {
        "Authorization": f"Bearer {token}",
        "chatgpt-account-id": account,
        "OpenAI-Beta": "responses=experimental",
        "originator": "pi",
        "session-id": session,
        "x-client-request-id": session,
        "accept": "text/event-stream",
        "content-type": "application/json",
    }
    deadline = time.monotonic() + args.timeout
    text_parts: list[str] = []
    citations: list[dict] = []
    actions: list[str] = []
    final_text = None
    timeout = httpx.Timeout(args.timeout, connect=min(15, args.timeout))
    with httpx.Client(timeout=timeout) as client:
        with client.stream("POST", CODEX_URL, headers=headers, json=body) as resp:
            if resp.status_code != 200:
                err = resp.read().decode(errors="replace")[:1500]
                hint = " (login expired? run `codex login`)" if resp.status_code in (401, 403) else ""
                raise CliError(f"Codex backend HTTP {resp.status_code}{hint}: {err}")
            for line in resp.iter_lines():
                if time.monotonic() > deadline:
                    raise CliError(f"Codex response exceeded {args.timeout}s.")
                if not line.startswith("data:"):
                    continue
                data = line[5:].strip()
                if not data or data == "[DONE]":
                    continue
                ev = json.loads(data)
                t = ev.get("type")
                if t == "response.output_text.delta":
                    text_parts.append(ev.get("delta", ""))
                elif t == "response.output_item.done":
                    item = ev.get("item") or {}
                    if item.get("type") == "web_search_call":
                        a = item.get("action") or {}
                        desc = a.get("query") or a.get("url") or ", ".join(a.get("queries") or [])
                        actions.append(f"{a.get('type', 'search')}: {desc}".strip())
                    elif item.get("type") == "message":
                        for part in item.get("content") or []:
                            if part.get("type") == "output_text":
                                final_text = (final_text or "") + part.get("text", "")
                                for ann in part.get("annotations") or []:
                                    if ann.get("type") == "url_citation":
                                        citations.append(ann)
                elif t in ("response.failed", "error"):
                    err = (ev.get("response") or {}).get("error") or ev.get("error") or ev
                    raise CliError(f"Codex backend error: {json.dumps(err)[:1500]}")
                elif t == "response.incomplete":
                    reason = ((ev.get("response") or {}).get("incomplete_details") or {}).get("reason")
                    text_parts.append(f"\n[Response incomplete: {reason}]")
    text = final_text if final_text is not None else "".join(text_parts)
    if not text.strip():
        raise CliError("Codex backend returned no text.")
    return text, citations, actions


def format_sources(citations: list[dict]) -> str:
    seen: dict[str, str] = {}
    for c in citations:
        url = clean_url(c.get("url", ""))
        if url and url not in seen:
            seen[url] = (c.get("title") or "").strip()
    if not seen:
        return ""
    lines = [f"{i}. {title + ' — ' if title else ''}{url}" for i, (url, title) in enumerate(seen.items(), 1)]
    return "\n\nSources:\n" + "\n".join(lines)


def codex_search(query: str, args) -> str:
    when = f" Only include results published in {TIMELIMITS[args.timelimit]}." if args.timelimit else ""
    instructions = (
        "You are a web search backend for another AI agent. Always use the web_search tool. "
        "Return results, not an essay: a numbered list of about N distinct, relevant results, each as "
        "'**Title** — URL' followed by 1-3 sentences of factual, specific information from that page "
        "(dates, numbers, names). Prefer primary and authoritative sources. Cite every result. "
        "If results conflict or are uncertain, say so briefly. Do not add a preamble or closing remarks."
    ).replace("about N", f"about {args.max_results}")
    text, citations, actions = codex_respond(f"Search the web for: {query}{when}", instructions, args)
    head = f"Provider: openai-codex ({args.model}, ChatGPT subscription web_search)\nQuery: {query}\n"
    if actions:
        head += "Searches: " + " | ".join(actions[:6]) + "\n"
    body = cap(clean_links(text), args.max_chars)
    return head + "\n" + body + format_sources(citations)


def codex_extract(url: str, args) -> str:
    instructions = (
        "You are a page-extraction backend for another AI agent. Use the web_search tool to open the exact "
        "URL given (do not substitute a different page unless it is unreachable, and say so if you do). "
        "Return the page's main content as Markdown, as completely and faithfully as you are permitted: "
        "keep headings, lists, tables, code, figures' captions, dates, numbers and names. Skip navigation, "
        "ads, cookie banners and footers. Where you cannot reproduce text verbatim, give a dense, "
        "section-by-section paraphrase and mark it '[paraphrased]'. Start with '# <page title>' and a line "
        "'URL: <url>'. No preamble or closing remarks."
    )
    text, citations, actions = codex_respond(f"Open and extract this page: {url}", instructions, args)
    head = (f"Provider: openai-codex ({args.model}, ChatGPT subscription web_search)\nURL: {url}\n"
            "Note: backend page view via the model, not a raw fetch; it may be paraphrased or partial. "
            "Quote sparingly and verify critical details.\n")
    if actions:
        head += "Actions: " + " | ".join(actions[:6]) + "\n"
    body = cap(clean_links(text), args.max_chars)
    return head + "\n" + body + format_sources(citations)


# -------------------------------------------------------------------- ddgs

def ddgs_search(query: str, args) -> str:
    from ddgs import DDGS

    kwargs = {"max_results": args.max_results}
    if args.timelimit:
        kwargs["timelimit"] = args.timelimit
    # ddgs' "auto" backend sometimes returns nothing while individual engines work,
    # so try a few engines in turn (all within the ddgs provider).
    client = DDGS(timeout=max(5, min(15, args.timeout // 3)))
    deadline = time.monotonic() + args.timeout - 3
    results, errors = [], []
    for backend in ("auto", "google", "bing", "yahoo"):
        if time.monotonic() > deadline:
            break
        try:
            results = client.text(query, backend=backend, **kwargs)
        except Exception as e:
            errors.append(f"{backend}: {e}")
            continue
        if results:
            break
    if not results:
        raise CliError("ddgs returned no results (" + "; ".join(errors) + ").")
    lines = []
    for i, r in enumerate(results, 1):
        lines.append(f"{i}. **{clip(r.get('title') or '', 150)}** — {r.get('href', '')}\n   {clip(r.get('body') or '')}")
    return f"Provider: ddgs\nQuery: {query}\n\n" + cap("\n".join(lines), args.max_chars)


def ddgs_extract(url: str, args) -> str:
    from ddgs import DDGS

    content = DDGS(timeout=max(5, args.timeout - 5)).extract(url, fmt="text_markdown").get("content") or ""
    if isinstance(content, bytes):
        content = content.decode(errors="replace")
    if not content.strip():
        raise CliError("ddgs extracted no content (page may require JavaScript; try camoufox).")
    return f"Provider: ddgs (direct fetch)\nURL: {url}\n\n" + cap(content, args.max_chars)


# ----------------------------------------------------------------- camoufox

def camoufox_extract(url: str, args) -> str:
    from camoufox.sync_api import Camoufox
    from markdownify import markdownify

    try:
        with Camoufox(headless=True, i_know_what_im_doing=True) as browser:
            page = browser.new_page()
            page.goto(url, timeout=args.timeout * 1000, wait_until="domcontentloaded")
            try:
                page.wait_for_load_state("networkidle", timeout=min(8000, args.timeout * 300))
            except Exception:
                pass
            title = page.title()
            html = page.evaluate(
                "() => { for (const s of document.querySelectorAll('script,style,noscript,svg,nav,footer,header,iframe')) s.remove();"
                " const m = document.querySelector('main, article, [role=main]'); return (m || document.body).innerHTML; }"
            )
    except Exception as e:
        msg = str(e)
        if "fetch" in msg.lower() and ("not found" in msg.lower() or "install" in msg.lower()):
            raise CliError(f"Camoufox browser not installed. Run `uvx camoufox fetch` once. ({msg[:300]})")
        raise
    md = markdownify(html, heading_style="ATX")
    md = re.sub(r"\n{3,}", "\n\n", md)
    if not md.strip():
        raise CliError("camoufox rendered no content.")
    return f"Provider: camoufox (rendered browser)\nURL: {url}\nTitle: {title}\n\n" + cap(md, args.max_chars)


# --------------------------------------------------------------------- main

def main(argv=None) -> int:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("command", choices=["search", "extract"])
    p.add_argument("value", help="search query or URL (put after --)")
    p.add_argument("--provider", default="openai-codex", choices=["openai-codex", "ddgs", "camoufox"])
    p.add_argument("--timeout", type=int, default=30, help="seconds")
    p.add_argument("--max-chars", type=int, default=None)
    p.add_argument("--max-results", type=int, default=5)
    p.add_argument("--timelimit", choices=list(TIMELIMITS))
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Codex model (default {DEFAULT_MODEL})")
    p.add_argument("--effort", default=DEFAULT_EFFORT, help=f"Codex reasoning effort (default {DEFAULT_EFFORT})")
    args = p.parse_args(argv)
    if args.max_chars is None:
        args.max_chars = 8000 if args.command == "search" else 20000

    value = args.value.strip()
    if not value:
        p.error("value must not be blank")
    if args.command == "extract" and urlsplit(value).scheme not in ("http", "https"):
        p.error("extract requires an http(s) URL")

    handlers = {
        ("search", "openai-codex"): codex_search,
        ("search", "ddgs"): ddgs_search,
        ("extract", "openai-codex"): codex_extract,
        ("extract", "ddgs"): ddgs_extract,
        ("extract", "camoufox"): camoufox_extract,
    }
    handler = handlers.get((args.command, args.provider))
    if handler is None:
        p.error(f"provider {args.provider} does not support {args.command}")
    try:
        out = handler(value, args)
    except CliError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    except Exception as e:  # surface provider failures without fallback
        print(f"error: {args.provider} {args.command} failed: {type(e).__name__}: {e}", file=sys.stderr)
        return 1
    print(out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
