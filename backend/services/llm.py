"""LLM client — OpenRouter, llama.cpp, or Gemini, switched via LLM_PROVIDER env var."""

import json
import logging
import re
import time
from fastapi import HTTPException
from prompts.mastery_guide import build_mastery_guide_prompt
from core.config import settings

logger = logging.getLogger(__name__)

OPENROUTER_DEFAULT_MODEL = "nvidia/nemotron-3-super-120b-a12b:free"


# ── OpenRouter error classification ────────────────────────────────────────

def _classify_error(exc: Exception, model: str, elapsed_ms: int) -> HTTPException:
    """Turn a raw OpenRouter exception into a structured HTTPException."""
    msg = str(exc).lower()

    if "429" in msg or "rate limit" in msg or "rate_limit" in msg or "too many requests" in msg:
        return HTTPException(status_code=503, detail={
            "error": f"{model} is rate-limited right now due to high demand.",
            "error_code": "RATE_LIMITED",
            "model": model,
            "suggestion": "Wait a few minutes and try again, or switch to a different model.",
        })

    if "timeout" in msg or "timed out" in msg or elapsed_ms >= 44_000:
        return HTTPException(status_code=504, detail={
            "error": f"{model} did not respond within the timeout ({elapsed_ms // 1000}s).",
            "error_code": "TIMEOUT",
            "model": model,
            "suggestion": "The model may be overloaded. Try again or pick a faster model.",
        })

    if "503" in msg or "service unavailable" in msg or "unavailable" in msg:
        return HTTPException(status_code=503, detail={
            "error": f"{model} is temporarily unavailable (503 from provider).",
            "error_code": "MODEL_UNAVAILABLE",
            "model": model,
            "suggestion": "This endpoint may be degraded. Try a different model.",
        })

    if "502" in msg or "bad gateway" in msg:
        return HTTPException(status_code=502, detail={
            "error": f"{model} returned a bad gateway error.",
            "error_code": "BAD_GATEWAY",
            "model": model,
            "suggestion": "The model's backend may be restarting. Retry in a moment.",
        })

    if "connection" in msg or "econnrefused" in msg or "network" in msg:
        return HTTPException(status_code=503, detail={
            "error": "Could not reach OpenRouter. Check your internet connection.",
            "error_code": "CONNECTION_ERROR",
            "model": model,
            "suggestion": "Verify OPENROUTER_API_KEY is set and you have internet access.",
        })

    # Unknown error — include the raw message so it's debuggable
    return HTTPException(status_code=502, detail={
        "error": f"{model} failed: {str(exc)[:300]}",
        "error_code": "OPENROUTER_ERROR",
        "model": model,
        "suggestion": "Check the backend logs for more detail.",
    })


# ── OpenRouter (OpenAI-compatible) ─────────────────────────────────────────

_openrouter_client = None


def _get_openrouter():
    global _openrouter_client
    if _openrouter_client is None:
        import httpx
        from openai import OpenAI
        if not settings.openrouter_api_key:
            raise RuntimeError("OPENROUTER_API_KEY is not set in backend/.env")
        _openrouter_client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=settings.openrouter_api_key,
            timeout=httpx.Timeout(connect=10.0, read=45.0, write=30.0, pool=5.0),
        )
    return _openrouter_client


def _openrouter_complete(system: str, user: str, model: str, request_id: str = "") -> str:
    client = _get_openrouter()
    rid = f"rid={request_id} | " if request_id else ""
    logger.info(f"{rid}llm_attempt | model={model}")
    t0 = time.perf_counter()

    try:
        stream = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            max_tokens=4096,
            stream=True,
            # Reasoning-capable free-tier models (e.g. Nemotron) can emit their
            # chain-of-thought as regular content instead of a separate
            # reasoning delta, burning the whole max_tokens budget on planning
            # text and never reaching the actual answer. Ask OpenRouter to
            # drop reasoning generation entirely rather than relying on a
            # delta-field split that isn't guaranteed for every model/endpoint.
            extra_body={"reasoning": {"exclude": True}},
        )
        chunks: list[str] = []
        for chunk in stream:
            if chunk.choices and chunk.choices[0].delta.content:
                chunks.append(chunk.choices[0].delta.content)
        content = "".join(chunks)
    except HTTPException:
        raise
    except Exception as exc:
        ms = int((time.perf_counter() - t0) * 1000)
        logger.warning(f"{rid}llm_error | model={model} | {ms}ms | {exc}")
        raise _classify_error(exc, model, ms)

    ms = int((time.perf_counter() - t0) * 1000)

    if not content:
        logger.warning(f"{rid}llm_empty | model={model} | {ms}ms")
        raise HTTPException(status_code=502, detail={
            "error": f"{model} returned an empty response.",
            "error_code": "EMPTY_RESPONSE",
            "model": model,
            "suggestion": (
                "This endpoint may be degraded or discontinued. "
                "Try a different model."
            ),
        })

    logger.info(f"{rid}llm_ok | model={model} | {ms}ms | chars={len(content)}")
    return content


# ── llama.cpp (OpenAI-compatible local server) ─────────────────────────────

def _llamacpp_complete(system: str, user: str, max_tokens: int = 2000, request_id: str = "") -> str:
    import httpx
    rid = f"rid={request_id} | " if request_id else ""
    logger.info(f"{rid}llm_attempt | model=llamacpp | url={settings.llamacpp_base_url}")
    t0 = time.perf_counter()

    payload = {
        "model": settings.llamacpp_model,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": user},
        ],
        "max_tokens": max_tokens,
        "stream": True,
    }
    chunks: list[str] = []
    try:
        with httpx.Client(timeout=httpx.Timeout(connect=10, read=1800, write=30, pool=10)) as client:
            with client.stream(
                "POST",
                f"{settings.llamacpp_base_url}/v1/chat/completions",
                json=payload,
            ) as resp:
                if resp.status_code != 200:
                    error = resp.read().decode()
                    raise RuntimeError(f"HTTP {resp.status_code}: {error[:300]}")
                for line in resp.iter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        try:
                            data = json.loads(line[6:])
                            delta = data["choices"][0]["delta"].get("content", "")
                            if delta:
                                chunks.append(delta)
                        except Exception:
                            pass
    except HTTPException:
        raise
    except Exception as e:
        ms = int((time.perf_counter() - t0) * 1000)
        logger.error(f"{rid}llm_error | model=llamacpp | {ms}ms | {e}")
        raise HTTPException(status_code=502, detail={
            "error": f"Local llama.cpp server error: {e}",
            "error_code": "LLAMACPP_UNAVAILABLE",
            "model": "llamacpp",
            "suggestion": (
                "Make sure llama.cpp is running: "
                "./llama-server -m gemma-4-e2b.gguf --port 8080 --chat-template gemma"
            ),
        })

    ms = int((time.perf_counter() - t0) * 1000)
    content = "".join(chunks)
    if not content:
        logger.warning(f"{rid}llm_empty | model=llamacpp | {ms}ms")
        raise HTTPException(status_code=502, detail={
            "error": "llama.cpp returned no content.",
            "error_code": "LLAMACPP_EMPTY",
            "model": "llamacpp",
            "suggestion": "Check that the llama.cpp model is fully loaded.",
        })

    logger.info(f"{rid}llm_ok | model=llamacpp | {ms}ms | chars={len(content)}")
    return content


# ── Gemini ─────────────────────────────────────────────────────────────────

_gemini_client = None


def _get_gemini():
    global _gemini_client
    if _gemini_client is None:
        from google import genai
        if not settings.google_api_key:
            raise RuntimeError("GOOGLE_API_KEY is not set in backend/.env")
        _gemini_client = genai.Client(api_key=settings.google_api_key)
    return _gemini_client


def _gemini_complete(prompt: str, request_id: str = "") -> str:
    from google.genai import errors as genai_errors
    rid = f"rid={request_id} | " if request_id else ""
    logger.info(f"{rid}llm_attempt | model=gemini-2.0-flash")
    t0 = time.perf_counter()
    client = _get_gemini()
    try:
        response = client.models.generate_content(model="gemini-2.0-flash", contents=prompt)
        ms = int((time.perf_counter() - t0) * 1000)
        logger.info(f"{rid}llm_ok | model=gemini-2.0-flash | {ms}ms")
        return response.text
    except genai_errors.ClientError as e:
        ms = int((time.perf_counter() - t0) * 1000)
        logger.error(f"{rid}llm_error | model=gemini-2.0-flash | {ms}ms | {e}")
        if e.status_code == 429:
            raise HTTPException(status_code=503, detail={
                "error": "Gemini quota exhausted.",
                "error_code": "GEMINI_QUOTA",
                "model": "gemini-2.0-flash",
                "suggestion": "Enable billing on Google AI Studio or switch LLM_PROVIDER.",
            })
        raise HTTPException(status_code=502, detail={
            "error": f"Gemini API error: {e}",
            "error_code": "GEMINI_ERROR",
            "model": "gemini-2.0-flash",
            "suggestion": "Check the backend logs for more detail.",
        })


# ── Public API ──────────────────────────────────────────────────────────────

def generate_mastery_guide(
    source_text: str,
    title: str = "",
    model_override: str | None = None,
    request_id: str = "",
) -> str:
    system = "Follow the instructions in the user message exactly. Output only HTML."

    # model_override from the request header always wins over the .env default
    use_llamacpp = model_override == "llamacpp" or (
        model_override is None and settings.llm_provider == "llamacpp"
    )
    if use_llamacpp:
        prompt = build_mastery_guide_prompt(source_text[:6000], title)
        return _llamacpp_complete(system, prompt, max_tokens=2048, request_id=request_id)
    if model_override is None and settings.llm_provider == "gemini":
        prompt = build_mastery_guide_prompt(source_text, title)
        return _gemini_complete(prompt, request_id=request_id)

    model = model_override or OPENROUTER_DEFAULT_MODEL
    prompt = build_mastery_guide_prompt(source_text, title)
    return _openrouter_complete(system, prompt, model=model, request_id=request_id)


def extract_metadata(
    source_text: str,
    model_override: str | None = None,
    request_id: str = "",
) -> dict:
    user_prompt = (
        f"Extract the main title and up to 5 topic keywords from the text below.\n"
        f"Return ONLY valid JSON: {{\"title\": \"...\", \"topics\": [\"...\", \"...\"]}}\n\n"
        f"TEXT:\n{source_text[:1500]}"
    )
    system = "You extract metadata. Return only valid JSON, no commentary."

    use_llamacpp = model_override == "llamacpp" or (
        model_override is None and settings.llm_provider == "llamacpp"
    )
    if use_llamacpp:
        text = _llamacpp_complete(system, user_prompt, max_tokens=200, request_id=request_id)
    elif model_override is None and settings.llm_provider == "gemini":
        text = _gemini_complete(user_prompt, request_id=request_id)
    else:
        model = model_override or OPENROUTER_DEFAULT_MODEL
        text = _openrouter_complete(system, user_prompt, model=model, request_id=request_id)

    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.MULTILINE).strip()
    return json.loads(text)
