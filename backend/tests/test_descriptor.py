"""Tests for AI-generated note descriptor."""
from unittest.mock import MagicMock, patch

import pytest

from services.descriptor import generate


_OPENAI_ENDPOINT = {
    "url": "https://openrouter.ai/api/v1/chat/completions",
    "headers": {"Authorization": "Bearer test-key"},
    "model": "test-model",
    "source": "openrouter",
}


def _mock_client(text: str):
    """Return a context-manager mock whose .post() returns a valid OpenAI response."""
    resp = MagicMock()
    resp.raise_for_status = MagicMock()
    resp.json.return_value = {
        "choices": [{"message": {"content": text}}]
    }
    client = MagicMock()
    client.__enter__ = MagicMock(return_value=client)
    client.__exit__ = MagicMock(return_value=False)
    client.post.return_value = resp
    return client


def test_generate_returns_llm_text():
    with patch("services.descriptor.get_endpoint", return_value=_OPENAI_ENDPOINT):
        with patch("services.descriptor.httpx.Client", return_value=_mock_client("A note about ML.")):
            result = generate("Machine Learning", ["gradient descent", "backprop"])
    assert result == "A note about ML."


def test_generate_sends_title_and_content_in_prompt():
    captured = {}

    def capture_post(url, *, headers, json, **kwargs):
        captured["json"] = json
        resp = MagicMock()
        resp.raise_for_status = MagicMock()
        resp.json.return_value = {"choices": [{"message": {"content": "ok"}}]}
        return resp

    client_mock = MagicMock()
    client_mock.__enter__ = MagicMock(return_value=client_mock)
    client_mock.__exit__ = MagicMock(return_value=False)
    client_mock.post = capture_post

    with patch("services.descriptor.get_endpoint", return_value=_OPENAI_ENDPOINT):
        with patch("services.descriptor.httpx.Client", return_value=client_mock):
            generate("My Note Title", ["block one text", "block two text"])

    prompt_text = captured["json"]["messages"][0]["content"]
    assert "My Note Title" in prompt_text
    assert "block one text" in prompt_text


def test_fallback_when_no_api_key():
    with patch("services.descriptor.get_endpoint", side_effect=RuntimeError("no key")):
        result = generate("Deep Learning", ["neural networks are used everywhere"])
    assert result.startswith("Deep Learning")
    assert "neural networks" in result


def test_fallback_when_http_fails():
    with patch("services.descriptor.get_endpoint", return_value=_OPENAI_ENDPOINT):
        with patch("services.descriptor.httpx.Client") as MockCls:
            client_mock = MagicMock()
            client_mock.__enter__ = MagicMock(return_value=client_mock)
            client_mock.__exit__ = MagicMock(return_value=False)
            client_mock.post.side_effect = Exception("connection refused")
            MockCls.return_value = client_mock
            result = generate("Deep Learning", ["neural nets"])
    assert result.startswith("Deep Learning")


def test_fallback_with_no_blocks():
    with patch("services.descriptor.get_endpoint", side_effect=RuntimeError("no key")):
        result = generate("Empty Note", [])
    assert result == "Empty Note."


def test_strips_whitespace_from_llm_output():
    with patch("services.descriptor.get_endpoint", return_value=_OPENAI_ENDPOINT):
        with patch("services.descriptor.httpx.Client", return_value=_mock_client("  Padded descriptor.  ")):
            result = generate("Title", ["block"])
    assert result == "Padded descriptor."
