from pathlib import Path

import pytest

from apkmesh_debug.models import SourceManifest
from apkmesh_debug.policy import SourcePolicy


def manifest(**permissions):
    return SourceManifest.from_raw(
        {
            "id": "test",
            "name": "Test",
            "permissions": {
                "network": ["example.com", "*.cdn.example.com"],
                **permissions,
            },
        }
    )


def test_policy_matches_declared_hosts_only():
    policy = SourcePolicy(manifest())

    assert policy.permits("https://example.com/app")
    assert policy.permits("https://img.cdn.example.com/icon.png")
    assert not policy.permits("https://cdn.example.com/icon.png")
    assert not policy.permits("file:///tmp/app.apk")
    assert not policy.permits("https://example.com.evil.test/app")


def test_policy_allows_explicit_any_host_permission():
    policy = SourcePolicy(manifest(network=["*"]))

    assert policy.permits("https://temporary.r2.cloudflarestorage.com/file.apk")
    assert policy.permits("http://example.test/redirect")
    assert not policy.permits("file:///tmp/app.apk")


def test_manifest_rejects_invalid_network_permission():
    with pytest.raises(ValueError, match="string array"):
        manifest(network="example.com")
