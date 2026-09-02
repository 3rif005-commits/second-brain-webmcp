"""Tests for the model router."""
from unittest.mock import patch

import pytest

from models.agent import Mode
from services.agent.model import get_endpoint


@patch("services.agent.model.smart_router")
def test_local_uses_smart_router(mock_smart):
    mock_smart.get_endpoint.return_value = {
        "url": "http://tablet:8082/v1/chat/completions",
        "headers": {"Content-Type": "application/json"},
        "model": "gemma-4-e2b",
        "source": "tablet",
    }
    ep = get_endpoint(Mode.LOCAL, task="chat")
    assert ep["source"] == "tablet"
    assert "tablet" in ep["url"]


@patch("services.agent.model.settings")
def test_api_openrouter(mock_settings):
    mock_settings.api_provider = "openrouter"
    mock_settings.openrouter_api_key = "or-key"
    mock_settings.api_model_openrouter = "nvidia/nemotron-3-super-120b-a12b:free"
    ep = get_endpoint(Mode.API, task="chat")
    assert ep["source"] == "openrouter"
    assert ep["headers"]["Authorization"] == "Bearer or-key"
    assert ep["url"].endswith("/chat/completions")
    assert ep["model"] == "nvidia/nemotron-3-super-120b-a12b:free"


@patch("services.agent.model.settings")
def test_api_anthropic(mock_settings):
    mock_settings.api_provider = "anthropic"
    mock_settings.anthropic_api_key = "ant-key"
    mock_settings.api_model_anthropic = "claude-sonnet-4-6"
    ep = get_endpoint(Mode.API, task="chat")
    assert ep["source"] == "anthropic"
    assert ep["headers"]["x-api-key"] == "ant-key"
    assert ep["headers"]["anthropic-version"] == "2023-06-01"


@patch("services.agent.model.settings")
def test_api_missing_key_raises(mock_settings):
    mock_settings.api_provider = "openrouter"
    mock_settings.openrouter_api_key = None
    with pytest.raises(RuntimeError, match="API key"):
        get_endpoint(Mode.API, task="chat")
