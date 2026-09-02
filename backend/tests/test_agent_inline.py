"""Tests for the inline AI endpoint config.

The /agent/inline route is a transparent OpenAI-compatible streaming proxy;
the unit-testable surface is the endpoint selection: always OpenRouter with
settings.inline_model (forced tool-calling support), failing loudly when the
key is missing.
"""
from unittest.mock import patch

import pytest

from routers import agent_inline


def test_inline_endpoint_uses_openrouter_and_inline_model():
    with patch.object(agent_inline.settings, "openrouter_api_key", "sk-test"), \
         patch.object(agent_inline.settings, "inline_model", "openai/gpt-4o-mini"):
        ep = agent_inline._inline_endpoint()

    assert ep["url"] == "https://openrouter.ai/api/v1/chat/completions"
    assert ep["model"] == "openai/gpt-4o-mini"
    assert ep["headers"]["Authorization"] == "Bearer sk-test"


def test_inline_endpoint_requires_api_key():
    with patch.object(agent_inline.settings, "openrouter_api_key", ""):
        with pytest.raises(RuntimeError, match="OPENROUTER_API_KEY"):
            agent_inline._inline_endpoint()
