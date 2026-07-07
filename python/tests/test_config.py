from __future__ import annotations

import pytest

from netra_observe._config import Config, NetraConfigError, resolve


def test_resolve_defaults(monkeypatch):
    monkeypatch.delenv("NETRA_OTEL_ENDPOINT", raising=False)
    cfg = resolve(api_key="sk_live_k")
    assert cfg.endpoint == "https://api.netraruntime.com/v1/otel"
    assert cfg.gateway_host == "api.netraruntime.com"
    assert cfg.project is None and cfg.environment is None


def test_resolve_env_fallbacks(monkeypatch):
    monkeypatch.setenv("NETRA_API_KEY", "sk_live_env")
    monkeypatch.setenv("NETRA_OTEL_ENDPOINT", "http://localhost:8080/v1/otel/")
    monkeypatch.setenv("NETRA_PROJECT", "p1")
    monkeypatch.setenv("NETRA_ENVIRONMENT", "staging")
    cfg = resolve()
    assert cfg.api_key == "sk_live_env"
    assert cfg.endpoint == "http://localhost:8080/v1/otel"  # trailing slash stripped
    assert cfg.gateway_host == "localhost:8080"  # port preserved
    assert cfg.project == "p1" and cfg.environment == "staging"


def test_args_beat_env(monkeypatch):
    monkeypatch.setenv("NETRA_API_KEY", "sk_live_env")
    assert resolve(api_key="sk_live_arg").api_key == "sk_live_arg"


def test_missing_key_raises(monkeypatch):
    monkeypatch.delenv("NETRA_API_KEY", raising=False)
    with pytest.raises(NetraConfigError):
        resolve()
