#!/bin/bash
set -euo pipefail

EXIT_COMPATIBILITY=78
SUPPORTED_NODE_MAJOR=26
CONFIG_FORMAT="icarus.node-runtime-compatibility/1"
INSTALL_NODE_VERSION="26.5.0"
INSTALL_PLATFORM="darwin"
INSTALL_ARCH="arm64"
INSTALL_ARCHIVE_FILENAME="node-v${INSTALL_NODE_VERSION}-${INSTALL_PLATFORM}-${INSTALL_ARCH}.tar.gz"
INSTALL_ARCHIVE_URL="https://nodejs.org/dist/v${INSTALL_NODE_VERSION}/${INSTALL_ARCHIVE_FILENAME}"
INSTALL_ARCHIVE_CHECKSUM="sha256:ee920559aaa2391569cff4d737e3b83963430e3a14dedd91bfe0ff53171b5af9"
TEMP_PATHS=()
LOCK_PATH=""

fail() {
  local code="$1"
  shift
  if [ "$#" -gt 0 ]; then
    echo "icarus-toolchain:${code}: $*" >&2
  else
    echo "icarus-toolchain:${code}" >&2
  fi
  exit "$EXIT_COMPATIBILITY"
}

cleanup() {
  local temporary
  for temporary in "${TEMP_PATHS[@]:-}"; do
    if [ -n "$temporary" ] && [ -e "$temporary" ]; then
      rm -rf "$temporary"
    fi
  done
  if [ -n "$LOCK_PATH" ]; then
    rmdir "$LOCK_PATH" 2>/dev/null || true
  fi
}

trap cleanup EXIT INT TERM

resolve_self() {
  local target="$1"
  local directory
  local link
  local hops=0

  while [ -L "$target" ]; do
    hops=$((hops + 1))
    [ "$hops" -le 32 ] || fail path_resolution_failed "$target"
    directory="$(cd -P "$(dirname "$target")" && pwd)"
    link="$(readlink "$target")"
    if [[ "$link" = /* ]]; then
      target="$link"
    else
      target="$directory/$link"
    fi
  done
  [ -e "$target" ] || fail node_executable_missing "$target"
  directory="$(cd -P "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$directory" "$(basename "$target")"
}

SELF_PATH="$(resolve_self "$0")"
SCRIPT_DIR="$(dirname "$SELF_PATH")"
REPOSITORY_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"

sha256_file() {
  local file="$1"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$file" | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
    return
  fi
  fail sha256_tool_missing
}

host_platform() {
  case "$(uname -s)" in
    Darwin) printf 'darwin\n' ;;
    Linux) printf 'linux\n' ;;
    *) fail platform_unsupported "$(uname -s)" ;;
  esac
}

host_arch() {
  case "$(uname -m)" in
    arm64|aarch64) printf 'arm64\n' ;;
    x86_64|amd64) printf 'x64\n' ;;
    *) fail architecture_unsupported "$(uname -m)" ;;
  esac
}

json_string() {
  local file="$1"
  local key="$2"
  local count
  local line
  local value

  count="$(sed -nE "/^[[:space:]]*\"${key}\"[[:space:]]*:/p" "$file" | wc -l | tr -d '[:space:]')"
  [ "$count" = "1" ] || fail runtime_config_invalid "field=${key} count=${count}"
  line="$(sed -nE "/^[[:space:]]*\"${key}\"[[:space:]]*:/p" "$file")"
  value="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*"[^\"]+"[[:space:]]*:[[:space:]]*"([^\"\\]*)"[[:space:]]*,?[[:space:]]*$/\1/')"
  [ "$value" != "$line" ] || fail runtime_config_invalid "field=${key}"
  printf '%s\n' "$value"
}

assert_plain_json_string() {
  local field="$1"
  local value="$2"
  if [[ "$value" == *'"'* ]] || [[ "$value" == *'\'* ]] || [[ "$value" == *$'\n'* ]] || [[ "$value" == *$'\r'* ]]; then
    fail runtime_config_invalid "field=${field}"
  fi
}

runtime_layout() {
  RUNTIME_HOME="$1"
  NODE_ROOT="$RUNTIME_HOME/toolchains/node"
  CONFIG_PATH="$NODE_ROOT/runtime.json"
  MANAGED_INSTALL_PATH="$NODE_ROOT/managed/v${INSTALL_NODE_VERSION}-${INSTALL_PLATFORM}-${INSTALL_ARCH}"
}

ensure_safe_directory() {
  local directory="$1"
  [ ! -L "$directory" ] || fail runtime_path_unsafe "$directory"
  if [ -e "$directory" ]; then
    [ -d "$directory" ] || fail runtime_path_unsafe "$directory"
  else
    mkdir "$directory"
  fi
}

ensure_node_root() {
  ensure_safe_directory "$RUNTIME_HOME/toolchains"
  ensure_safe_directory "$NODE_ROOT"
}

probe_node() {
  local node_path="$1"
  local descriptor

  [ -f "$node_path" ] && [ -x "$node_path" ] || fail node_executable_missing "$node_path"
  descriptor="$("$node_path" --eval 'const major=Number(process.versions.node.split(".")[0]); process.stdout.write([major,process.versions.modules,process.platform,process.arch].join("|"))' 2>/dev/null || true)"
  IFS='|' read -r PROBE_MAJOR PROBE_ABI PROBE_PLATFORM PROBE_ARCH <<< "$descriptor"
  [[ "$PROBE_MAJOR" =~ ^[1-9][0-9]*$ ]] || fail node_descriptor_invalid "major=${PROBE_MAJOR:-missing}"
  [[ "$PROBE_ABI" =~ ^[1-9][0-9]*$ ]] || fail node_descriptor_invalid "modules_abi=${PROBE_ABI:-missing}"
  [ -n "$PROBE_PLATFORM" ] || fail node_descriptor_invalid platform
  [ -n "$PROBE_ARCH" ] || fail node_descriptor_invalid arch
}

assert_supported_probe() {
  [ "$PROBE_MAJOR" = "$SUPPORTED_NODE_MAJOR" ] || fail node_major_unsupported "supported=${SUPPORTED_NODE_MAJOR} actual=${PROBE_MAJOR}"
  [ "$PROBE_PLATFORM" = "$(host_platform)" ] || fail node_platform_incompatible "expected=$(host_platform) actual=${PROBE_PLATFORM}"
  [ "$PROBE_ARCH" = "$(host_arch)" ] || fail node_arch_incompatible "expected=$(host_arch) actual=${PROBE_ARCH}"
}

write_config() {
  local temporary

  ensure_node_root
  temporary="$(mktemp "$NODE_ROOT/.runtime.json.XXXXXX")"
  TEMP_PATHS+=("$temporary")
  printf '%s\n' \
    '{' \
    '  "format": "'"${CONFIG_FORMAT}"'",' \
    '  "node_path": "'"${CONFIG_NODE_PATH}"'",' \
    '  "node_major": "'"${PROBE_MAJOR}"'",' \
    '  "modules_abi": "'"${PROBE_ABI}"'",' \
    '  "platform": "'"${PROBE_PLATFORM}"'",' \
    '  "arch": "'"${PROBE_ARCH}"'"' \
    '}' > "$temporary"
  chmod 600 "$temporary"
  mv -f "$temporary" "$CONFIG_PATH"
}

configure_node() {
  local input="$1"

  [[ "$input" = /* ]] || fail node_path_not_absolute "$input"
  CONFIG_NODE_PATH="$(resolve_self "$input")"
  assert_plain_json_string node_path "$CONFIG_NODE_PATH"
  probe_node "$CONFIG_NODE_PATH"
  assert_supported_probe
  write_config
}

load_config() {
  local actual_keys
  local expected_keys
  local actual

  [ -f "$CONFIG_PATH" ] && [ ! -L "$CONFIG_PATH" ] || fail runtime_config_missing "$CONFIG_PATH"
  actual_keys="$(sed -nE 's/^[[:space:]]*"([^\"]+)"[[:space:]]*:.*/\1/p' "$CONFIG_PATH" | LC_ALL=C sort)"
  expected_keys="$(printf '%s\n' arch format modules_abi node_major node_path platform | LC_ALL=C sort)"
  [ "$actual_keys" = "$expected_keys" ] || fail runtime_config_invalid keyset
  CONFIG_FORMAT_VALUE="$(json_string "$CONFIG_PATH" format)"
  CONFIG_NODE_PATH="$(json_string "$CONFIG_PATH" node_path)"
  CONFIG_NODE_MAJOR="$(json_string "$CONFIG_PATH" node_major)"
  CONFIG_MODULES_ABI="$(json_string "$CONFIG_PATH" modules_abi)"
  CONFIG_PLATFORM="$(json_string "$CONFIG_PATH" platform)"
  CONFIG_ARCH="$(json_string "$CONFIG_PATH" arch)"
  [ "$CONFIG_FORMAT_VALUE" = "$CONFIG_FORMAT" ] || fail runtime_config_invalid format
  [[ "$CONFIG_NODE_PATH" = /* ]] || fail runtime_config_invalid node_path
  assert_plain_json_string node_path "$CONFIG_NODE_PATH"
  actual="$(resolve_self "$CONFIG_NODE_PATH")"
  [ "$actual" = "$CONFIG_NODE_PATH" ] || fail configured_node_path_changed "configured=${CONFIG_NODE_PATH} actual=${actual}"
  probe_node "$CONFIG_NODE_PATH"
  assert_supported_probe
  [ "$CONFIG_NODE_MAJOR" = "$PROBE_MAJOR" ] || fail configured_node_major_mismatch "configured=${CONFIG_NODE_MAJOR} actual=${PROBE_MAJOR}"
  [ "$CONFIG_MODULES_ABI" = "$PROBE_ABI" ] || fail configured_node_abi_mismatch "configured=${CONFIG_MODULES_ABI} actual=${PROBE_ABI}"
  [ "$CONFIG_PLATFORM" = "$PROBE_PLATFORM" ] || fail configured_node_platform_mismatch "configured=${CONFIG_PLATFORM} actual=${PROBE_PLATFORM}"
  [ "$CONFIG_ARCH" = "$PROBE_ARCH" ] || fail configured_node_arch_mismatch "configured=${CONFIG_ARCH} actual=${PROBE_ARCH}"
}

native_module_smoke() {
  if ! ICARUS_NODE_MODULE_ROOT="$REPOSITORY_ROOT" "$CONFIG_NODE_PATH" --eval '
    const { createRequire } = require("node:module");
    const path = require("node:path");
    const localRequire = createRequire(path.join(process.env.ICARUS_NODE_MODULE_ROOT, "package.json"));
    const Database = localRequire("better-sqlite3");
    const database = new Database(":memory:");
    try {
      const row = database.prepare("SELECT 1 AS value").get();
      if (!row || row.value !== 1) process.exit(2);
    } finally {
      database.close();
    }
  ' >/dev/null 2>&1; then
    fail native_module_incompatible "better-sqlite3 failed under the configured Node; run npm rebuild better-sqlite3 or npm ci"
  fi
}

verify_runtime() {
  load_config
  native_module_smoke
}

validate_archive() {
  local archive="$1"
  local top_directory="${INSTALL_ARCHIVE_FILENAME%.tar.gz}"

  if ! tar -tzf "$archive" | awk -v top="$top_directory" '
    BEGIN { found = 0 }
    {
      entry = $0
      if (entry == "" || entry ~ /^[[:space:]]/ || entry ~ /[[:space:]\\]/ || entry ~ /^\//) exit 1
      count = split(entry, parts, "/")
      for (i = 1; i <= count; i++) if (parts[i] == "..") exit 1
      if (parts[1] != top) exit 1
      found = 1
    }
    END { if (!found) exit 1 }
  '; then
    fail archive_unsafe_entry
  fi

  if ! tar -tvzf "$archive" | awk '
    {
      kind = substr($1, 1, 1)
      if (kind != "-" && kind != "d" && kind != "l") exit 1
      if (kind == "l") {
        path = $(NF - 2)
        target = $NF
        if (target ~ /^\// || target ~ /[[:space:]\\]/) exit 1
        slash = match(path, /\/[^\/]*$/)
        base = slash ? substr(path, 1, slash - 1) : ""
        combined = base "/" target
        count = split(combined, parts, "/")
        depth = 0
        for (i = 1; i <= count; i++) {
          if (parts[i] == "" || parts[i] == ".") continue
          if (parts[i] == "..") {
            depth--
            if (depth < 1) exit 1
          } else depth++
        }
      }
    }
  '; then
    fail archive_unsafe_link
  fi
}

install_runtime() {
  local archive_override="$1"
  local expected_checksum="$2"
  local work_directory
  local archive
  local actual
  local extract_root
  local payload
  local install_parent

  [ "$(host_platform)" = "$INSTALL_PLATFORM" ] || fail managed_installer_platform_unsupported
  [ "$(host_arch)" = "$INSTALL_ARCH" ] || fail managed_installer_arch_unsupported
  [[ "$expected_checksum" =~ ^sha256:[0-9a-f]{64}$ ]] || fail archive_checksum_invalid
  install_parent="$(dirname "$MANAGED_INSTALL_PATH")"
  ensure_node_root
  ensure_safe_directory "$install_parent"
  local install_lock="${MANAGED_INSTALL_PATH}.install-lock"
  if ! mkdir "$install_lock" 2>/dev/null; then
    fail install_lock_busy "$install_lock"
  fi
  LOCK_PATH="$install_lock"
  [ ! -L "$MANAGED_INSTALL_PATH" ] || fail runtime_path_unsafe "$MANAGED_INSTALL_PATH"
  if [ -e "$MANAGED_INSTALL_PATH" ] && [ ! -d "$MANAGED_INSTALL_PATH" ]; then
    fail runtime_path_unsafe "$MANAGED_INSTALL_PATH"
  fi
  if [ ! -d "$MANAGED_INSTALL_PATH" ]; then
    work_directory="$(mktemp -d "$install_parent/.install.XXXXXX")"
    TEMP_PATHS+=("$work_directory")
    archive="$work_directory/$INSTALL_ARCHIVE_FILENAME"
    extract_root="$work_directory/extract"
    mkdir -p "$extract_root"
    if [ -n "$archive_override" ]; then
      [ -f "$archive_override" ] || fail archive_missing "$archive_override"
      cp "$archive_override" "$archive"
    else
      command -v curl >/dev/null 2>&1 || fail download_tool_missing curl
      curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$INSTALL_ARCHIVE_URL" || fail archive_download_failed "$INSTALL_ARCHIVE_URL"
    fi
    actual="sha256:$(sha256_file "$archive")"
    [ "$actual" = "$expected_checksum" ] || fail archive_checksum_mismatch "expected=${expected_checksum} actual=${actual}"
    validate_archive "$archive"
    tar -xzf "$archive" -C "$extract_root" --no-same-owner --no-same-permissions || fail archive_extract_failed
    payload="$extract_root/${INSTALL_ARCHIVE_FILENAME%.tar.gz}"
    [ -d "$payload" ] || fail archive_layout_invalid
    [ -x "$payload/bin/node" ] || fail node_executable_missing "$payload/bin/node"
    mv "$payload" "$MANAGED_INSTALL_PATH"
  fi
  [ ! -L "$MANAGED_INSTALL_PATH/bin/node" ] || fail runtime_path_unsafe "$MANAGED_INSTALL_PATH/bin/node"
  case "$(resolve_self "$MANAGED_INSTALL_PATH/bin/node")" in
    "$MANAGED_INSTALL_PATH"/*) ;;
    *) fail runtime_path_unsafe "$MANAGED_INSTALL_PATH/bin/node" ;;
  esac
  configure_node "$MANAGED_INSTALL_PATH/bin/node"
}

configured_npm_ci() {
  local node_directory
  local npm_path

  load_config
  unset NODE_OPTIONS NODE_PATH ICARUS_RUNTIME_HOME ICARUS_TOOLCHAIN_MANIFEST
  node_directory="$(dirname "$CONFIG_NODE_PATH")"
  npm_path="$node_directory/npm"
  [ -f "$npm_path" ] && [ -x "$npm_path" ] || fail package_tool_missing "$npm_path"
  cd "$REPOSITORY_ROOT"
  PATH="$node_directory:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin" "$npm_path" ci
}

launch_active() {
  local mode="$1"
  local entry
  local node_directory

  load_config
  unset NODE_OPTIONS NODE_PATH ICARUS_TOOLCHAIN_MANIFEST
  entry="$("$CONFIG_NODE_PATH" --eval '
    const crypto = require("node:crypto");
    const fs = require("node:fs");
    const { createRequire } = require("node:module");
    const path = require("node:path");

    function invalid(reason) {
      process.stderr.write(`icarus-toolchain:active_snapshot_invalid: ${reason}\n`);
      process.exit(78);
    }

    function regularFile(file, label) {
      let stat;
      try {
        stat = fs.lstatSync(file);
      } catch {
        invalid(`${label}_missing`);
      }
      if (!stat.isFile() || stat.isSymbolicLink()) invalid(`${label}_invalid`);
    }

    function exactKeys(value, expected, label) {
      if (value === null || typeof value !== "object" || Array.isArray(value))
        invalid(`${label}_invalid`);
      const actual = Object.keys(value).sort();
      const required = [...expected].sort();
      if (actual.length !== required.length || actual.some((key, index) => key !== required[index]))
        invalid(`${label}_keyset_invalid`);
    }

    try {
      const runtimeHome = fs.realpathSync(process.argv[1]);
      const snapshotsRoot = path.join(runtimeHome, "host-core-snapshots");
      const snapshotsStat = fs.lstatSync(snapshotsRoot);
      if (!snapshotsStat.isDirectory() || snapshotsStat.isSymbolicLink())
        invalid("snapshot_directory_invalid");

      const pointer = path.join(runtimeHome, "active-core");
      if (!fs.lstatSync(pointer).isSymbolicLink()) invalid("pointer_invalid");
      const relative = fs.readlinkSync(pointer);
      const match = /^host-core-snapshots\/(\d{8}T\d{6}Z-[0-9a-f]{7,12}-[0-9a-f]{8})$/.exec(relative);
      if (!match) invalid("pointer_invalid");

      const snapshotId = match[1];
      const expectedRoot = path.join(snapshotsRoot, snapshotId);
      const expectedStat = fs.lstatSync(expectedRoot);
      if (!expectedStat.isDirectory() || expectedStat.isSymbolicLink())
        invalid("snapshot_directory_invalid");
      const snapshotRoot = fs.realpathSync(pointer);
      if (snapshotRoot !== fs.realpathSync(expectedRoot)) invalid("pointer_invalid");
      const contained = path.relative(fs.realpathSync(snapshotsRoot), snapshotRoot);
      if (contained !== snapshotId || contained.startsWith(`..${path.sep}`) || path.isAbsolute(contained))
        invalid("snapshot_path_invalid");

      const manifestFile = path.join(snapshotRoot, "snapshot.json");
      regularFile(manifestFile, "manifest");
      const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
      exactKeys(manifest, [
        "created_at", "entry_relative_path", "entry_sha256", "format", "git",
        "label", "node", "snapshot_id", "validation", "workflow_schema",
      ], "manifest");
      exactKeys(manifest.node, ["arch", "major", "modules_abi", "platform"], "manifest_node");
      exactKeys(manifest.workflow_schema, ["current_version", "minimum_supported_version"], "manifest_schema");
      if (manifest.format !== "icarus.host-core-snapshot/1" || manifest.snapshot_id !== snapshotId)
        invalid("manifest_descriptor_invalid");
      if (manifest.entry_relative_path !== "dist/index.js" ||
          typeof manifest.entry_sha256 !== "string" ||
          !/^sha256:[0-9a-f]{64}$/.test(manifest.entry_sha256))
        invalid("entry_descriptor_invalid");
      const currentSchema = manifest.workflow_schema.current_version;
      const minimumSchema = manifest.workflow_schema.minimum_supported_version;
      if (!Number.isSafeInteger(currentSchema) || currentSchema < 1 ||
          !Number.isSafeInteger(minimumSchema) || minimumSchema < 1 || minimumSchema > currentSchema)
        invalid("schema_range_invalid");

      const major = Number(process.versions.node.split(".")[0]);
      if (manifest.node.major !== major ||
          manifest.node.modules_abi !== process.versions.modules ||
          manifest.node.platform !== process.platform ||
          manifest.node.arch !== process.arch)
        invalid("node_incompatible");

      const entry = path.join(snapshotRoot, manifest.entry_relative_path);
      regularFile(entry, "entry");
      const digest = `sha256:${crypto.createHash("sha256").update(fs.readFileSync(entry)).digest("hex")}`;
      if (digest !== manifest.entry_sha256) invalid("entry_checksum_mismatch");

      const packageFile = path.join(snapshotRoot, "package.json");
      regularFile(packageFile, "package_manifest");
      const snapshotRequire = createRequire(packageFile);
      const dependencyRoot = path.join(snapshotRoot, "node_modules");
      const dependencyStat = fs.lstatSync(dependencyRoot);
      if (!dependencyStat.isDirectory() || dependencyStat.isSymbolicLink())
        invalid("dependency_directory_invalid");
      const sqliteEntry = fs.realpathSync(snapshotRequire.resolve("better-sqlite3"));
      const dependencyRelative = path.relative(fs.realpathSync(dependencyRoot), sqliteEntry);
      if (dependencyRelative === ".." || dependencyRelative.startsWith(`..${path.sep}`) || path.isAbsolute(dependencyRelative))
        invalid("native_module_outside_snapshot");
      const Database = snapshotRequire(sqliteEntry);
      const database = new Database(":memory:");
      try {
        const row = database.prepare("SELECT 1 AS value").get();
        if (!row || row.value !== 1) invalid("native_module_smoke_failed");
      } finally {
        database.close();
      }
      process.stdout.write(entry);
    } catch (error) {
      invalid(error instanceof Error ? error.message : "verification_failed");
    }
  ' "$RUNTIME_HOME")"
  if [ "$mode" = "verify" ]; then
    return 0
  fi
  node_directory="$(dirname "$CONFIG_NODE_PATH")"
  PATH="$node_directory:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin" \
    ICARUS_RUNTIME_HOME="$RUNTIME_HOME" exec "$CONFIG_NODE_PATH" "$entry"
}

configured_exec() {
  local command
  local node_directory

  [ "$#" -gt 0 ] || fail exec_command_missing
  verify_runtime
  unset NODE_OPTIONS NODE_PATH ICARUS_RUNTIME_HOME ICARUS_TOOLCHAIN_MANIFEST
  command="$1"
  shift
  node_directory="$(dirname "$CONFIG_NODE_PATH")"
  case "$command" in
    node) command="$CONFIG_NODE_PATH" ;;
    npm|npx)
      command="$node_directory/$command"
      [ -f "$command" ] && [ -x "$command" ] || fail package_tool_missing "$command"
      ;;
  esac
  PATH="$node_directory:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin" exec "$command" "$@"
}

print_runtime() {
  printf 'node_path=%s\n' "$CONFIG_NODE_PATH"
  printf 'node_major=%s\n' "$PROBE_MAJOR"
  printf 'node_modules_abi=%s\n' "$PROBE_ABI"
  printf 'node_platform=%s\n' "$PROBE_PLATFORM"
  printf 'node_arch=%s\n' "$PROBE_ARCH"
}

usage() {
  echo "Usage: scripts/runtime-toolchain.sh [--runtime-home PATH] <configure --node PATH|npm-ci|verify|exec -- COMMAND...|install [--archive PATH --checksum SHA256]|verify-active|launch-active>" >&2
  exit 64
}

RUNTIME_HOME_ARG=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-home)
      [ "$#" -ge 2 ] || usage
      RUNTIME_HOME_ARG="$2"
      shift 2
      ;;
    --*) usage ;;
    *) break ;;
  esac
done

[ "$#" -gt 0 ] || usage
COMMAND="$1"
shift
if [ -z "$RUNTIME_HOME_ARG" ]; then
  [ -n "${HOME:-}" ] || fail runtime_home_unavailable
  RUNTIME_HOME_ARG="$HOME/Library/Application Support/Icarus"
fi
mkdir -p "$RUNTIME_HOME_ARG"
RUNTIME_HOME_ARG="$(cd -P "$RUNTIME_HOME_ARG" && pwd)"
runtime_layout "$RUNTIME_HOME_ARG"

case "$COMMAND" in
  configure)
    [ "$#" -eq 2 ] && [ "$1" = "--node" ] || usage
    configure_node "$2"
    print_runtime
    ;;
  verify)
    [ "$#" -eq 0 ] || usage
    verify_runtime
    print_runtime
    ;;
  npm-ci)
    [ "$#" -eq 0 ] || usage
    configured_npm_ci
    ;;
  exec)
    [ "${1:-}" = "--" ] || usage
    shift
    configured_exec "$@"
    ;;
  install)
    ARCHIVE_OVERRIDE=""
    ARCHIVE_CHECKSUM="$INSTALL_ARCHIVE_CHECKSUM"
    if [ "$#" -gt 0 ]; then
      [ "$#" -eq 4 ] && [ "$1" = "--archive" ] && [ "$3" = "--checksum" ] || usage
      ARCHIVE_OVERRIDE="$2"
      ARCHIVE_CHECKSUM="$4"
    fi
    install_runtime "$ARCHIVE_OVERRIDE" "$ARCHIVE_CHECKSUM"
    print_runtime
    ;;
  launch-active)
    [ "$#" -eq 0 ] || usage
    launch_active launch
    ;;
  verify-active)
    [ "$#" -eq 0 ] || usage
    launch_active verify
    ;;
  *) usage ;;
esac
