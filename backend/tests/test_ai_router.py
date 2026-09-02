"""Tests for the provider-agnostic AI layer: capability routing + degradation."""
from unittest.mock import patch

from services.ai.providers import Provider, CAPABILITIES, local_provider
from services.ai.router import pick


def _gemini():
    return Provider("gemini", api_key="k", capabilities=set(CAPABILITIES["gemini"]))


def _openai():
    return Provider("openai", api_key="k", capabilities=set(CAPABILITIES["openai"]))


def _openrouter():
    return Provider("openai_compatible", api_key="k",
                    base_url="https://openrouter.ai/api/v1",
                    capabilities=set(CAPABILITIES["openai_compatible"]))


def test_video_job_prefers_video_native():
    p = pick("summarize_video", "u", providers=[_openai(), _gemini(), local_provider()])
    assert p is not None and p.provider == "gemini"


def test_video_job_degrades_to_text_when_no_gemini():
    p = pick("summarize_video", "u", providers=[_openrouter(), local_provider()])
    assert p is not None and p.provider == "openai_compatible"


def test_chat_falls_back_to_local_when_nothing_configured():
    p = pick("chat", "u", providers=[local_provider()])
    assert p is not None and p.provider == "local"


def test_formula_ocr_requires_vision():
    assert pick("formula_ocr", "u", providers=[_openrouter(), local_provider()]) is None
    p = pick("formula_ocr", "u", providers=[_openrouter(), _openai()])
    assert p is not None and p.provider == "openai"


def test_formula_ocr_never_routes_to_local():
    # local advertises text only, but guard against future capability edits
    lp = local_provider()
    lp.capabilities.add("vision")
    assert pick("formula_ocr", "u", providers=[lp]) is None


def test_user_configured_provider_wins_over_env():
    user_gemini = Provider("gemini", api_key="user-key", label="mine",
                           capabilities=set(CAPABILITIES["gemini"]))
    env_gemini = Provider("gemini", api_key="env-key", label="env",
                          capabilities=set(CAPABILITIES["gemini"]))
    p = pick("summarize_text", "u", providers=[user_gemini, env_gemini])
    assert p is not None and p.api_key == "user-key"


def test_unknown_job_defaults_to_text_chain():
    p = pick("mystery_job", "u", providers=[_openrouter()])
    assert p is not None and p.provider == "openai_compatible"


def test_env_providers_from_settings():
    from services.ai import providers as prov_mod
    with patch.object(prov_mod.settings, "google_api_key", "g"), \
         patch.object(prov_mod.settings, "anthropic_api_key", None), \
         patch.object(prov_mod.settings, "openai_api_key", None), \
         patch.object(prov_mod.settings, "openrouter_api_key", "or"):
        env = prov_mod._env_providers()
    kinds = [p.provider for p in env]
    assert kinds == ["gemini", "openai_compatible"]
    assert "video_native" in env[0].capabilities


def test_candidates_ordered_by_capability_chain():
    from services.ai.router import candidates
    ranked = candidates("summarize_video", "u",
                        providers=[_openai(), _gemini(), local_provider()])
    assert [p.provider for p in ranked] == ["gemini", "openai", "local"]


def test_complete_with_fallback_skips_failing_provider():
    from services.ai import router as router_mod

    good = _openai()
    with patch.object(router_mod, "candidates", return_value=[_gemini(), good]), \
         patch("services.ai.client.complete",
               side_effect=[RuntimeError("429 quota"), "hello"]) as mock_complete:
        out = router_mod.complete_with_fallback("chat", "u", [{"role": "user", "content": "hi"}])
    assert out == "hello"
    assert mock_complete.call_count == 2
    assert mock_complete.call_args[0][0] is good


def test_complete_with_fallback_skips_response_that_fails_validation():
    from services.ai import router as router_mod

    good = _openai()
    with patch.object(router_mod, "candidates", return_value=[_gemini(), good]), \
         patch("services.ai.client.complete",
               side_effect=["<p>just reasoning, no real output</p>", "<h1>ok</h1>"]) as mock_complete:
        out = router_mod.complete_with_fallback(
            "chat", "u", [{"role": "user", "content": "hi"}],
            validate=lambda html: "<h1" in html)
    assert out == "<h1>ok</h1>"
    assert mock_complete.call_count == 2
    assert mock_complete.call_args[0][0] is good


def test_complete_with_fallback_raises_when_all_responses_fail_validation():
    from services.ai import router as router_mod
    with patch.object(router_mod, "candidates", return_value=[_gemini()]), \
         patch("services.ai.client.complete", return_value="not a real answer"):
        try:
            router_mod.complete_with_fallback(
                "chat", "u", [], validate=lambda html: "<h1" in html)
            assert False, "should have raised"
        except RuntimeError as e:
            assert "All AI providers failed" in str(e)
            assert "failed validation" in str(e)


def test_complete_with_fallback_without_validate_accepts_anything():
    """Backward compatibility: existing callers that don't pass `validate`
    keep today's behavior — any non-exception response is accepted."""
    from services.ai import router as router_mod
    with patch.object(router_mod, "candidates", return_value=[_gemini()]), \
         patch("services.ai.client.complete", return_value="whatever"):
        out = router_mod.complete_with_fallback("chat", "u", [])
    assert out == "whatever"


def test_complete_with_fallback_raises_when_all_fail():
    from services.ai import router as router_mod
    with patch.object(router_mod, "candidates", return_value=[_gemini()]), \
         patch("services.ai.client.complete", side_effect=RuntimeError("boom")):
        try:
            router_mod.complete_with_fallback("chat", "u", [])
            assert False, "should have raised"
        except RuntimeError as e:
            assert "All AI providers failed" in str(e)


def test_provider_model_override():
    p = Provider("gemini", api_key="k", chat_model="gemini-2.5-pro")
    assert p.model == "gemini-2.5-pro"
    p2 = Provider("gemini", api_key="k")
    assert p2.model  # default exists
