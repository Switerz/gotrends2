"""Small stdio MCP client for the local Google Ads MCP server."""

from __future__ import annotations

import json
import os
import queue
import subprocess
import tempfile
import threading
import time
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]


class GoogleAdsMcpClient:
    """Call tools exposed by the local google-ads-mcp stdio server."""

    def __init__(
        self,
        login_customer_id: str | None = None,
        config_path: Path | None = None,
        timeout_seconds: int = 90,
    ) -> None:
        self.login_customer_id = login_customer_id
        self.config_path = config_path
        self.timeout_seconds = timeout_seconds
        self._request_id = 0
        self._temp_config: Path | None = None
        self._proc: subprocess.Popen[str] | None = None
        self._stdout: queue.Queue[str] = queue.Queue()

    def __enter__(self) -> "GoogleAdsMcpClient":
        cfg = json.loads((ROOT / ".mcp.json").read_text())["mcpServers"]["google-ads-mcp"]
        env = os.environ.copy()
        env.update(cfg.get("env", {}))
        if self.login_customer_id:
            env.pop("GOOGLE_ADS_LOGIN_CUSTOMER_ID", None)
            config_file = self.config_path or Path.home() / "google-ads.yaml"
            if config_file.exists():
                self._temp_config = _config_with_login_customer(config_file, self.login_customer_id)
                env["GOOGLE_ADS_CONFIGURATION_FILE_PATH"] = str(self._temp_config)

        self._proc = subprocess.Popen(
            [cfg["command"], *cfg.get("args", [])],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=env,
        )
        threading.Thread(target=self._read_stdout, daemon=True).start()
        self._initialize()
        return self

    def __exit__(self, *_exc: object) -> None:
        if self._proc:
            self._proc.terminate()
        if self._temp_config and self._temp_config.exists():
            self._temp_config.unlink()

    def call_tool(self, name: str, arguments: dict[str, Any] | None = None) -> Any:
        request_id = self._next_id()
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "tools/call",
                "params": {"name": name, "arguments": arguments or {}},
            }
        )
        payload = self._wait(request_id, self.timeout_seconds)
        if "error" in payload:
            raise RuntimeError(payload["error"])
        content = payload.get("result", {}).get("content", [])
        text = " ".join(
            item.get("text", "") for item in content if isinstance(item, dict)
        ).strip()
        if not text:
            return None
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def search(
        self,
        customer_id: str,
        resource: str,
        fields: list[str],
        conditions: list[str] | None = None,
        orderings: list[str] | None = None,
        limit: int | None = None,
    ) -> list[dict[str, Any]]:
        result = self.call_tool(
            "search_search",
            {
                "customer_id": customer_id,
                "resource": resource,
                "fields": fields,
                "conditions": conditions or [],
                "orderings": orderings or [],
                "limit": limit,
            },
        )
        if isinstance(result, str):
            raise RuntimeError(result)
        if not isinstance(result, list):
            raise RuntimeError(f"Unexpected Google Ads search response: {type(result).__name__}")
        return result

    def _initialize(self) -> None:
        request_id = self._next_id()
        self._send(
            {
                "jsonrpc": "2.0",
                "id": request_id,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": {"name": "gotrends-google-ads-client", "version": "1.0"},
                },
            }
        )
        self._send(
            {"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}}
        )
        self._wait(request_id, 20)

    def _next_id(self) -> int:
        self._request_id += 1
        return self._request_id

    def _send(self, payload: dict[str, Any]) -> None:
        if not self._proc or not self._proc.stdin:
            raise RuntimeError("MCP process is not running")
        self._proc.stdin.write(json.dumps(payload) + "\n")
        self._proc.stdin.flush()

    def _wait(self, request_id: int, timeout_seconds: int) -> dict[str, Any]:
        end_at = time.time() + timeout_seconds
        while time.time() < end_at:
            try:
                line = self._stdout.get(timeout=0.5)
            except queue.Empty:
                continue
            try:
                payload = json.loads(line)
            except json.JSONDecodeError:
                continue
            if payload.get("id") == request_id:
                return payload
        raise TimeoutError(f"Timed out waiting for MCP response id={request_id}")

    def _read_stdout(self) -> None:
        if not self._proc or not self._proc.stdout:
            return
        for line in self._proc.stdout:
            self._stdout.put(line)


def _config_with_login_customer(config_file: Path, login_customer_id: str) -> Path:
    text = config_file.read_text()
    lines = [
        line
        for line in text.splitlines()
        if not line.lower().strip().startswith("login_customer_id:")
    ]
    tmp = tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False, encoding="utf-8")
    with tmp:
        tmp.write("\n".join(lines).rstrip() + "\n")
        tmp.write(f"login_customer_id: {login_customer_id}\n")
    return Path(tmp.name)
