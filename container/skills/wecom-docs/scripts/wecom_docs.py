#!/usr/bin/env python3
import argparse
import json
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Optional


SKILL_CONFIG_PATH = Path("/home/node/.claude/skills/wecom-docs/references/config.json")


def fail(message: str) -> None:
    print(f"wecom_docs.py: {message}", file=sys.stderr)
    raise SystemExit(1)


def is_object(value: Any) -> bool:
    return isinstance(value, dict)


def read_json_file(path: Path) -> dict[str, Any]:
    try:
      data = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
      fail(f"config not found: {path}")
    except json.JSONDecodeError as err:
      fail(f"invalid json in {path}: {err}")
    if not is_object(data):
      fail(f"json root must be an object: {path}")
    return data


def load_config() -> tuple[dict[str, Any], Path]:
    return read_json_file(SKILL_CONFIG_PATH), SKILL_CONFIG_PATH


def string_value(value: Any) -> str:
    return value.strip() if isinstance(value, str) else ""


def int_value(value: Any, fallback: int = 0) -> int:
    try:
      return int(value)
    except (TypeError, ValueError):
      return fallback


def get_nested(source: dict[str, Any], path: list[str]) -> Any:
    cur: Any = source
    for key in path:
      if not is_object(cur):
        return None
      cur = cur.get(key)
    return cur


def token_file_path(config: dict[str, Any]) -> Optional[Path]:
    raw = string_value(get_nested(config, ["auth", "token_file"]))
    if not raw:
      return None
    return Path(raw)


def load_token_cache(config: dict[str, Any]) -> dict[str, Any]:
    path = token_file_path(config)
    if not path or not path.is_file():
      return {}
    try:
      data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
      fail(f"invalid token json in {path}: {err}")
    return data if is_object(data) else {}


def merged_auth(config: dict[str, Any]) -> dict[str, Any]:
    auth = config.get("auth") if is_object(config.get("auth")) else {}
    cache = load_token_cache(config)
    result = dict(auth)
    for key in ["access_token", "refresh_token", "open_id", "expires_at"]:
      if cache.get(key):
        result[key] = cache[key]
    return result


def save_token_cache(config: dict[str, Any], token_data: dict[str, Any]) -> None:
    path = token_file_path(config)
    if not path:
      fail("auth.token_file is not configured")
    path.parent.mkdir(parents=True, exist_ok=True)

    existing = load_token_cache(config)
    merged = {**existing, **token_data}
    expires_in = int_value(merged.get("expires_in"), 0)
    if expires_in > 0 and not merged.get("expires_at"):
      merged["expires_at"] = int(time.time()) + expires_in

    safe = {
      key: value
      for key, value in merged.items()
      if key
      in {
        "access_token",
        "refresh_token",
        "expires_at",
        "expires_in",
        "open_id",
        "scope",
        "token_type",
      }
      and value not in (None, "")
    }
    path.write_text(json.dumps(safe, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    try:
      path.chmod(0o600)
    except OSError:
      pass
    print(json.dumps({"ok": True, "token_file": str(path), "saved_keys": sorted(safe.keys())}, ensure_ascii=False, indent=2))


def mask(value: Any) -> str:
    text = string_value(value)
    if not text:
      return ""
    if len(text) <= 8:
      return "***"
    return f"{text[:4]}...{text[-4:]}"


def resolve_url(config: dict[str, Any], path_or_url: str) -> str:
    if path_or_url.startswith("http://") or path_or_url.startswith("https://"):
      return path_or_url
    base_url = string_value(config.get("base_url")) or "https://docs.qq.com"
    return base_url.rstrip("/") + "/" + path_or_url.lstrip("/")


def encode_query(url: str, query_items: list[str]) -> str:
    if not query_items:
      return url
    parsed = urllib.parse.urlsplit(url)
    query = dict(urllib.parse.parse_qsl(parsed.query, keep_blank_values=True))
    for item in query_items:
      if "=" not in item:
        fail(f"query item must be key=value: {item}")
      key, value = item.split("=", 1)
      query[key] = value
    return urllib.parse.urlunsplit(
      (parsed.scheme, parsed.netloc, parsed.path, urllib.parse.urlencode(query), parsed.fragment)
    )


def auth_headers(config: dict[str, Any]) -> dict[str, str]:
    auth = merged_auth(config)
    client_id = string_value(auth.get("client_id"))
    access_token = string_value(auth.get("access_token"))
    open_id = string_value(auth.get("open_id"))

    headers: dict[str, str] = {}
    extra_headers = config.get("headers") if is_object(config.get("headers")) else {}
    for key, value in extra_headers.items():
      if isinstance(key, str) and isinstance(value, str) and key and value:
        headers[key] = value

    if client_id:
      headers["Client-Id"] = client_id
    if access_token:
      headers["Access-Token"] = access_token
    if open_id:
      headers["Open-Id"] = open_id
    return headers


def parse_json_arg(value: Optional[str], file_path: Optional[str]) -> Optional[Any]:
    if value and file_path:
      fail("use only one of --json and --json-file")
    if file_path:
      return json.loads(Path(file_path).read_text(encoding="utf-8"))
    if value:
      return json.loads(value)
    return None


def http_request(
    config: dict[str, Any],
    method: str,
    path_or_url: str,
    payload: Optional[Any] = None,
    query: Optional[list[str]] = None,
    use_auth: bool = True,
) -> Any:
    method = method.upper()
    url = encode_query(resolve_url(config, path_or_url), query or [])
    headers = auth_headers(config) if use_auth else {}
    body: Optional[bytes] = None
    if payload is not None:
      body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
      headers["Content-Type"] = "application/json"
    headers.setdefault("Accept", "application/json")

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
      with urllib.request.urlopen(req, timeout=60) as res:
        raw = res.read()
        text = raw.decode("utf-8", errors="replace")
        if not text.strip():
          return {"status": res.status, "body": ""}
        try:
          return json.loads(text)
        except json.JSONDecodeError:
          return {"status": res.status, "body": text}
    except urllib.error.HTTPError as err:
      body_text = err.read().decode("utf-8", errors="replace")
      try:
        body_json: Any = json.loads(body_text)
      except json.JSONDecodeError:
        body_json = body_text
      fail(json.dumps({"status": err.code, "reason": err.reason, "body": body_json}, ensure_ascii=False))
    except urllib.error.URLError as err:
      fail(f"request failed: {err.reason}")


def endpoint(config: dict[str, Any], name: str) -> tuple[str, str]:
    endpoints = config.get("endpoints") if is_object(config.get("endpoints")) else {}
    item = endpoints.get(name) if is_object(endpoints.get(name)) else {}
    method = string_value(item.get("method") if is_object(item) else "") or "GET"
    path = string_value(item.get("path") if is_object(item) else "")
    if not path:
      fail(f"endpoint not configured: {name}")
    return method, path


def format_endpoint_path(path: str, values: dict[str, str]) -> str:
    for key, value in values.items():
      path = path.replace("{" + key + "}", urllib.parse.quote(value, safe=""))
    return path


def command_config_check(config: dict[str, Any], config_path: Path) -> None:
    auth = merged_auth(config)
    missing: list[str] = []
    for key in ["client_id"]:
      if not string_value(auth.get(key)):
        missing.append(f"auth.{key}")
    if not string_value(auth.get("access_token")):
      missing.append("auth.access_token or auth.token_file")
    if not string_value(auth.get("open_id")):
      missing.append("auth.open_id")

    output = {
      "config": str(config_path),
      "provider": config.get("provider", ""),
      "base_url": config.get("base_url", ""),
      "client_id": mask(auth.get("client_id")),
      "open_id": mask(auth.get("open_id")),
      "has_access_token": bool(string_value(auth.get("access_token"))),
      "has_refresh_token": bool(string_value(auth.get("refresh_token"))),
      "expires_at": auth.get("expires_at", 0),
      "token_file": string_value(get_nested(config, ["auth", "token_file"])),
      "missing": missing,
      "ok": len(missing) == 0,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))


def command_oauth_url(config: dict[str, Any], args: argparse.Namespace) -> None:
    auth = config.get("auth") if is_object(config.get("auth")) else {}
    oauth = auth.get("oauth") if is_object(auth.get("oauth")) else {}
    authorize_url = string_value(oauth.get("authorize_url"))
    client_id = string_value(auth.get("client_id"))
    redirect_uri = args.redirect_uri or string_value(auth.get("redirect_uri"))
    scope = args.scope or string_value(oauth.get("scope")) or "all"
    if not authorize_url:
      fail("auth.oauth.authorize_url is required")
    if not client_id:
      fail("auth.client_id is required")
    if not redirect_uri:
      fail("auth.redirect_uri or --redirect-uri is required")
    query = {
      "client_id": client_id,
      "redirect_uri": redirect_uri,
      "response_type": "code",
      "scope": scope,
    }
    if args.state:
      query["state"] = args.state
    url = authorize_url + ("&" if "?" in authorize_url else "?") + urllib.parse.urlencode(query)
    print(url)


def token_request(config: dict[str, Any], payload: dict[str, Any]) -> dict[str, Any]:
    auth = config.get("auth") if is_object(config.get("auth")) else {}
    oauth = auth.get("oauth") if is_object(auth.get("oauth")) else {}
    token_url = string_value(oauth.get("token_url"))
    style = string_value(oauth.get("token_request_style")) or "form"
    if not token_url:
      fail("auth.oauth.token_url is required")

    headers = {"Accept": "application/json"}
    if style == "json":
      body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
      headers["Content-Type"] = "application/json"
    else:
      body = urllib.parse.urlencode(payload).encode("utf-8")
      headers["Content-Type"] = "application/x-www-form-urlencoded"

    req = urllib.request.Request(token_url, data=body, headers=headers, method="POST")
    try:
      with urllib.request.urlopen(req, timeout=60) as res:
        data = json.loads(res.read().decode("utf-8", errors="replace"))
    except urllib.error.HTTPError as err:
      fail(f"token request failed {err.code}: {err.read().decode('utf-8', errors='replace')}")
    except urllib.error.URLError as err:
      fail(f"token request failed: {err.reason}")
    if not is_object(data):
      fail("token response is not a JSON object")
    return data


def command_exchange_code(config: dict[str, Any], args: argparse.Namespace) -> None:
    auth = config.get("auth") if is_object(config.get("auth")) else {}
    client_id = string_value(auth.get("client_id"))
    client_secret = string_value(auth.get("client_secret"))
    redirect_uri = args.redirect_uri or string_value(auth.get("redirect_uri"))
    if not client_id:
      fail("auth.client_id is required")
    if not client_secret:
      fail("auth.client_secret is required")
    if not redirect_uri:
      fail("auth.redirect_uri or --redirect-uri is required")
    data = token_request(
      config,
      {
        "grant_type": "authorization_code",
        "client_id": client_id,
        "client_secret": client_secret,
        "code": args.code,
        "redirect_uri": redirect_uri,
      },
    )
    save_token_cache(config, data)


def command_refresh_token(config: dict[str, Any]) -> None:
    auth = merged_auth(config)
    client_id = string_value(auth.get("client_id"))
    client_secret = string_value(auth.get("client_secret"))
    refresh_token = string_value(auth.get("refresh_token"))
    if not client_id:
      fail("auth.client_id is required")
    if not client_secret:
      fail("auth.client_secret is required")
    if not refresh_token:
      fail("auth.refresh_token or token_file refresh_token is required")
    data = token_request(
      config,
      {
        "grant_type": "refresh_token",
        "client_id": client_id,
        "client_secret": client_secret,
        "refresh_token": refresh_token,
      },
    )
    save_token_cache(config, data)


def command_request(config: dict[str, Any], args: argparse.Namespace) -> None:
    payload = parse_json_arg(args.json, args.json_file)
    data = http_request(
      config,
      args.method,
      args.path,
      payload=payload,
      query=args.query or [],
      use_auth=not args.no_auth,
    )
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_search(config: dict[str, Any], args: argparse.Namespace) -> None:
    method, path = endpoint(config, "search")
    payload: dict[str, Any] = {
      "keyword": args.keyword,
      "pageSize": args.page_size,
    }
    if args.page_token:
      payload["pageToken"] = args.page_token
    extra = parse_json_arg(args.payload, args.payload_file)
    if extra is not None:
      if not is_object(extra):
        fail("--payload must be a JSON object")
      payload.update(extra)
    data = http_request(config, method, path, payload=payload)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_filter(config: dict[str, Any], args: argparse.Namespace) -> None:
    method, path = endpoint(config, "filter")
    payload = parse_json_arg(args.payload, args.payload_file)
    if payload is None:
      payload = {"pageSize": args.page_size}
      if args.sort_type:
        payload["sortType"] = args.sort_type
    if not is_object(payload):
      fail("filter payload must be a JSON object")
    data = http_request(config, method, path, payload=payload)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_metadata(config: dict[str, Any], args: argparse.Namespace) -> None:
    method, path = endpoint(config, "metadata")
    path = format_endpoint_path(path, {"file_id": args.file_id})
    data = http_request(config, method, path)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_collaborators(config: dict[str, Any], args: argparse.Namespace) -> None:
    method, path = endpoint(config, "collaborators")
    path = format_endpoint_path(path, {"file_id": args.file_id})
    data = http_request(config, method, path)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_unread_count(config: dict[str, Any]) -> None:
    method, path = endpoint(config, "unread_count")
    data = http_request(config, method, path)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def command_saas_list(config: dict[str, Any], args: argparse.Namespace) -> None:
    method, path = endpoint(config, "saas_list")
    payload: dict[str, Any] = {
      "listType": args.list_type,
      "pageSize": args.page_size,
    }
    if args.page_token:
      payload["pageToken"] = args.page_token
    extra = parse_json_arg(args.payload, args.payload_file)
    if extra is not None:
      if not is_object(extra):
        fail("--payload must be a JSON object")
      payload.update(extra)
    data = http_request(config, method, path, payload=payload)
    print(json.dumps(data, ensure_ascii=False, indent=2))


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Operate WeCom/Tencent Docs APIs using skill config")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("config-check", help="validate config without printing secrets")

    oauth = sub.add_parser("oauth-url", help="print OAuth authorize URL")
    oauth.add_argument("--state", default="")
    oauth.add_argument("--scope", default="")
    oauth.add_argument("--redirect-uri", default="")

    exchange = sub.add_parser("exchange-code", help="exchange OAuth code and save token cache")
    exchange.add_argument("--code", required=True)
    exchange.add_argument("--redirect-uri", default="")

    sub.add_parser("refresh-token", help="refresh OAuth token and save token cache")

    req = sub.add_parser("request", help="call an arbitrary API path")
    req.add_argument("--method", required=True, choices=["GET", "POST", "PUT", "PATCH", "DELETE"])
    req.add_argument("--path", required=True)
    req.add_argument("--query", action="append", help="query item key=value")
    req.add_argument("--json", help="inline JSON request body")
    req.add_argument("--json-file", help="file containing JSON request body")
    req.add_argument("--no-auth", action="store_true")

    search = sub.add_parser("search", help="search documents by keyword")
    search.add_argument("--keyword", required=True)
    search.add_argument("--page-size", type=int, default=20)
    search.add_argument("--page-token", default="")
    search.add_argument("--payload", help="extra JSON object merged into request body")
    search.add_argument("--payload-file", help="file with extra JSON object")

    filt = sub.add_parser("filter", help="list/filter documents")
    filt.add_argument("--payload", help="full JSON request body")
    filt.add_argument("--payload-file", help="file with full JSON request body")
    filt.add_argument("--page-size", type=int, default=20)
    filt.add_argument("--sort-type", default="")

    meta = sub.add_parser("metadata", help="get document metadata")
    meta.add_argument("--file-id", required=True)

    collab = sub.add_parser("collaborators", help="get document collaborators")
    collab.add_argument("--file-id", required=True)

    sub.add_parser("unread-count", help="get unread notification count")

    saas = sub.add_parser("saas-list", help="call configured SaaS list endpoint")
    saas.add_argument("--list-type", required=True)
    saas.add_argument("--page-size", type=int, default=20)
    saas.add_argument("--page-token", default="")
    saas.add_argument("--payload", help="extra JSON object merged into request body")
    saas.add_argument("--payload-file", help="file with extra JSON object")

    return parser


def main() -> None:
    parser = build_parser()
    args = parser.parse_args()
    config, config_path = load_config()

    if args.command == "config-check":
      command_config_check(config, config_path)
    elif args.command == "oauth-url":
      command_oauth_url(config, args)
    elif args.command == "exchange-code":
      command_exchange_code(config, args)
    elif args.command == "refresh-token":
      command_refresh_token(config)
    elif args.command == "request":
      command_request(config, args)
    elif args.command == "search":
      command_search(config, args)
    elif args.command == "filter":
      command_filter(config, args)
    elif args.command == "metadata":
      command_metadata(config, args)
    elif args.command == "collaborators":
      command_collaborators(config, args)
    elif args.command == "unread-count":
      command_unread_count(config)
    elif args.command == "saas-list":
      command_saas_list(config, args)
    else:
      parser.print_help()
      raise SystemExit(2)


if __name__ == "__main__":
    main()
