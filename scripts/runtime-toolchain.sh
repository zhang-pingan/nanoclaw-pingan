#!/bin/bash
set -euo pipefail

EXIT_IDENTITY=78
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
  exit "$EXIT_IDENTITY"
}

cleanup() {
  local path
  for path in "${TEMP_PATHS[@]:-}"; do
    if [ -n "$path" ]; then
      rm -rf "$path"
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

  directory="$(cd -P "$(dirname "$target")" && pwd)"
  printf '%s/%s\n' "$directory" "$(basename "$target")"
}

SELF_PATH="$(resolve_self "$0")"
SCRIPT_DIR="$(dirname "$SELF_PATH")"
REPOSITORY_ROOT="$(cd -P "$SCRIPT_DIR/.." && pwd)"
DEFAULT_MANIFEST="$REPOSITORY_ROOT/src/workflow-runtime/contracts/toolchain/node-v26.5.0-darwin-arm64.json"

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

sha256_stdin() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | awk '{print $1}'
    return
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum | awk '{print $1}'
    return
  fi
  fail sha256_tool_missing
}

sync_filesystem() {
  sync
}

json_string() {
  local file="$1"
  local key="$2"
  local count
  local line
  local value

  count="$(sed -nE "/^[[:space:]]*\"${key}\"[[:space:]]*:/p" "$file" | wc -l | tr -d '[:space:]')"
  if [ "$count" != "1" ]; then
    fail manifest_invalid "field=${key} count=${count}"
  fi

  line="$(sed -nE "/^[[:space:]]*\"${key}\"[[:space:]]*:/p" "$file")"
  value="$(printf '%s\n' "$line" | sed -E 's/^[[:space:]]*"[^\"]+"[[:space:]]*:[[:space:]]*"([^\"\\]*)"[[:space:]]*,?[[:space:]]*$/\1/')"
  if [ "$value" = "$line" ]; then
    fail manifest_invalid "field=${key} must be a plain JSON string"
  fi
  printf '%s\n' "$value"
}

assert_plain_json_string() {
  local field="$1"
  local value="$2"
  if [[ "$value" == *'"'* ]] || [[ "$value" == *'\'* ]] || [[ "$value" == *$'\n'* ]] || [[ "$value" == *$'\r'* ]]; then
    fail manifest_invalid "field=${field} contains an unsupported escape"
  fi
}

assert_manifest_keyset() {
  local file="$1"
  local actual
  local expected

  actual="$(sed -nE 's/^[[:space:]]*"([^\"]+)"[[:space:]]*:.*/\1/p' "$file" | LC_ALL=C sort)"
  expected="$(printf '%s\n' \
    arch \
    archive_filename \
    archive_sha256 \
    archive_url \
    distribution_origin \
    format \
    id \
    manifest_hash \
    node_executable_relative_path \
    node_executable_sha256 \
    node_runtime_version \
    npm_version \
    platform \
    ref \
    version | LC_ALL=C sort)"
  if [ "$actual" != "$expected" ]; then
    fail manifest_invalid "unexpected, duplicate, or missing field"
  fi
}

assert_manifest_serialization() {
  local file="$1"
  local actual
  local expected

  actual="$(cat "$file")"
  expected="$(printf '%s\n' \
    '{' \
    '  "format": "'"${MANIFEST_FORMAT}"'",' \
    '  "ref": {' \
    '    "id": "'"${MANIFEST_REF_ID}"'",' \
    '    "version": "'"${MANIFEST_REF_VERSION}"'"' \
    '  },' \
    '  "node_runtime_version": "'"${NODE_VERSION}"'",' \
    '  "npm_version": "'"${NPM_VERSION}"'",' \
    '  "platform": "'"${MANIFEST_PLATFORM}"'",' \
    '  "arch": "'"${MANIFEST_ARCH}"'",' \
    '  "distribution_origin": "'"${DISTRIBUTION_ORIGIN}"'",' \
    '  "archive_filename": "'"${ARCHIVE_FILENAME}"'",' \
    '  "archive_url": "'"${ARCHIVE_URL}"'",' \
    '  "archive_sha256": "'"${ARCHIVE_SHA256}"'",' \
    '  "node_executable_relative_path": "'"${NODE_RELATIVE_PATH}"'",' \
    '  "node_executable_sha256": "'"${NODE_SHA256}"'",' \
    '  "manifest_hash": "'"${MANIFEST_HASH}"'"' \
    '}')"
  [ "$actual" = "$expected" ] || fail manifest_invalid "non-canonical JSON document"
}

load_manifest() {
  local file="$1"
  local canonical
  local calculated
  local expected_filename
  local expected_url

  if [ ! -f "$file" ]; then
    fail manifest_missing "$file"
  fi
  assert_manifest_keyset "$file"

  MANIFEST_FORMAT="$(json_string "$file" format)"
  MANIFEST_REF_ID="$(json_string "$file" id)"
  MANIFEST_REF_VERSION="$(json_string "$file" version)"
  NODE_VERSION="$(json_string "$file" node_runtime_version)"
  NPM_VERSION="$(json_string "$file" npm_version)"
  MANIFEST_PLATFORM="$(json_string "$file" platform)"
  MANIFEST_ARCH="$(json_string "$file" arch)"
  DISTRIBUTION_ORIGIN="$(json_string "$file" distribution_origin)"
  ARCHIVE_FILENAME="$(json_string "$file" archive_filename)"
  ARCHIVE_URL="$(json_string "$file" archive_url)"
  ARCHIVE_SHA256="$(json_string "$file" archive_sha256)"
  NODE_RELATIVE_PATH="$(json_string "$file" node_executable_relative_path)"
  NODE_SHA256="$(json_string "$file" node_executable_sha256)"
  MANIFEST_HASH="$(json_string "$file" manifest_hash)"

  assert_manifest_serialization "$file"

  assert_plain_json_string ref.id "$MANIFEST_REF_ID"
  assert_plain_json_string ref.version "$MANIFEST_REF_VERSION"
  assert_plain_json_string archive_url "$ARCHIVE_URL"

  [ "$MANIFEST_FORMAT" = "icarus.managed-node-runtime-distribution/1" ] || fail manifest_invalid "format"
  [ "$NODE_VERSION" = "26.5.0" ] || fail manifest_invalid "node_runtime_version"
  [ "$NPM_VERSION" = "11.17.0" ] || fail manifest_invalid "npm_version"
  [ "$MANIFEST_PLATFORM" = "darwin" ] || fail manifest_invalid "platform"
  [ "$MANIFEST_ARCH" = "arm64" ] || fail manifest_invalid "arch"
  [ "$DISTRIBUTION_ORIGIN" = "nodejs_official" ] || fail manifest_invalid "distribution_origin"
  [ "$NODE_RELATIVE_PATH" = "bin/node" ] || fail manifest_invalid "node_executable_relative_path"

  expected_filename="node-v${NODE_VERSION}-${MANIFEST_PLATFORM}-${MANIFEST_ARCH}.tar.gz"
  expected_url="https://nodejs.org/dist/v${NODE_VERSION}/${expected_filename}"
  [ "$ARCHIVE_FILENAME" = "$expected_filename" ] || fail manifest_invalid "archive_filename"
  [ "$ARCHIVE_URL" = "$expected_url" ] || fail manifest_invalid "archive_url"

  [[ "$MANIFEST_REF_ID" =~ ^[A-Za-z0-9._-]+$ ]] || fail manifest_invalid "ref.id"
  [[ "$MANIFEST_REF_VERSION" =~ ^[A-Za-z0-9._-]+$ ]] || fail manifest_invalid "ref.version"
  [[ "$ARCHIVE_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || fail manifest_invalid "archive_sha256"
  [[ "$NODE_SHA256" =~ ^sha256:[0-9a-f]{64}$ ]] || fail manifest_invalid "node_executable_sha256"
  [[ "$MANIFEST_HASH" =~ ^sha256:[0-9a-f]{64}$ ]] || fail manifest_invalid "manifest_hash"

  canonical="{\"arch\":\"${MANIFEST_ARCH}\",\"archive_filename\":\"${ARCHIVE_FILENAME}\",\"archive_sha256\":\"${ARCHIVE_SHA256}\",\"archive_url\":\"${ARCHIVE_URL}\",\"distribution_origin\":\"${DISTRIBUTION_ORIGIN}\",\"format\":\"${MANIFEST_FORMAT}\",\"node_executable_relative_path\":\"${NODE_RELATIVE_PATH}\",\"node_executable_sha256\":\"${NODE_SHA256}\",\"node_runtime_version\":\"${NODE_VERSION}\",\"npm_version\":\"${NPM_VERSION}\",\"platform\":\"${MANIFEST_PLATFORM}\",\"ref\":{\"id\":\"${MANIFEST_REF_ID}\",\"version\":\"${MANIFEST_REF_VERSION}\"}}"
  calculated="$(printf '%s\n%s' 'icarus:managed-node-runtime-distribution:1' "$canonical" | sha256_stdin)"
  if [ "$MANIFEST_HASH" != "sha256:${calculated}" ]; then
    fail manifest_hash_mismatch "expected=${MANIFEST_HASH} actual=sha256:${calculated}"
  fi
}

runtime_layout() {
  local runtime_home="$1"
  local archive_hex="${ARCHIVE_SHA256#sha256:}"

  RUNTIME_HOME="$runtime_home"
  NODE_ROOT="$RUNTIME_HOME/toolchains/node"
  INSTALL_RELATIVE_PATH="${NODE_VERSION}/${MANIFEST_PLATFORM}-${MANIFEST_ARCH}/${archive_hex}"
  INSTALL_PATH="$NODE_ROOT/$INSTALL_RELATIVE_PATH"
  ACTIVE_NODE_POINTER="$NODE_ROOT/active-node"
  CONTRACT_PATH="$RUNTIME_HOME/contracts/managed-node-runtime-distribution.json"
  RUNTIME_LAUNCHER_PATH="$RUNTIME_HOME/bin/icarus-runtime"
  INSTALLED_TOOLCHAIN_PATH="$RUNTIME_HOME/libexec/icarus-runtime-toolchain"
  ACTIVE_CORE_POINTER="$RUNTIME_HOME/active-core"
}

assert_relative_safe_path() {
  local path="$1"
  local label="$2"
  if [ -z "$path" ] || [[ "$path" = /* ]] || [[ "$path" == *'\'* ]] || [[ "/$path/" == *'/../'* ]] || [[ "/$path/" == *'/./'* ]]; then
    fail "$label" "$path"
  fi
}

validate_archive() {
  local archive="$1"
  local top_directory="${ARCHIVE_FILENAME%.tar.gz}"

  if ! tar -tzf "$archive" | awk -v top="$top_directory" '
    BEGIN { found = 0 }
    {
      entry = $0
      if (entry == "" || entry ~ /^[[:space:]]/ || entry ~ /[[:space:]\\]/ || entry ~ /^\//) exit 1
      count = split(entry, parts, "/")
      depth = 0
      for (i = 1; i <= count; i++) {
        if (parts[i] == "" || parts[i] == ".") continue
        if (parts[i] == "..") exit 1
        else {
          depth++
        }
      }
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
          } else {
            depth++
          }
        }
      }
    }
  '; then
    fail archive_unsafe_link
  fi
}

atomic_copy() {
  local source="$1"
  local destination="$2"
  local mode="$3"
  local parent
  local temporary

  parent="$(dirname "$destination")"
  mkdir -p "$parent"
  temporary="$(mktemp "$parent/.icarus-copy.XXXXXX")"
  TEMP_PATHS+=("$temporary")
  cp "$source" "$temporary"
  chmod "$mode" "$temporary"
  sync_filesystem
  mv -f "$temporary" "$destination"
  sync_filesystem
}

verify_distribution_dir() {
  local directory="$1"
  local source_manifest="$2"
  local node_path="$directory/$NODE_RELATIVE_PATH"
  local npm_path="$directory/bin/npm"
  local actual
  local directory_real
  local node_real

  if [ ! -d "$directory" ]; then
    fail installation_missing "$directory"
  fi
  if [ ! -f "$directory/manifest.json" ]; then
    fail installation_incomplete "$directory"
  fi
  if ! cmp -s "$source_manifest" "$directory/manifest.json"; then
    fail installation_manifest_mismatch "$directory"
  fi
  if [ ! -f "$node_path" ] || [ ! -x "$node_path" ] || [ -L "$node_path" ]; then
    fail node_executable_missing "$node_path"
  fi
  directory_real="$(cd -P "$directory" && pwd)"
  node_real="$(resolve_self "$node_path")"
  case "$node_real" in
    "$directory_real"/*) ;;
    *) fail node_executable_outside_install "$node_real" ;;
  esac
  actual="$(sha256_file "$node_path")"
  if [ "sha256:${actual}" != "$NODE_SHA256" ]; then
    fail node_executable_hash_mismatch "expected=${NODE_SHA256} actual=sha256:${actual}"
  fi
  actual="$("$node_path" --version 2>/dev/null || true)"
  if [ "$actual" != "v${NODE_VERSION}" ]; then
    fail node_version_mismatch "expected=v${NODE_VERSION} actual=${actual:-unavailable}"
  fi
  if [ ! -f "$npm_path" ] || [ ! -x "$npm_path" ]; then
    fail npm_executable_missing "$npm_path"
  fi
  case "$(resolve_self "$npm_path")" in
    "$directory"/*) ;;
    *) fail npm_executable_outside_install "$npm_path" ;;
  esac
  actual="$(PATH="$directory/bin:/usr/bin:/bin" "$npm_path" --version 2>/dev/null || true)"
  if [ "$actual" != "$NPM_VERSION" ]; then
    fail npm_version_mismatch "expected=${NPM_VERSION} actual=${actual:-unavailable}"
  fi
}

install_launcher_components() {
  local source_toolchain="$REPOSITORY_ROOT/scripts/runtime-toolchain.sh"
  local source_launcher="$REPOSITORY_ROOT/scripts/runtime-launcher.sh"

  if [ ! -f "$source_toolchain" ] || [ ! -f "$source_launcher" ]; then
    fail launcher_source_missing
  fi
  atomic_copy "$source_toolchain" "$INSTALLED_TOOLCHAIN_PATH" 755
  atomic_copy "$source_launcher" "$RUNTIME_LAUNCHER_PATH" 755
}

set_relative_pointer() {
  local pointer="$1"
  local relative_target="$2"
  local parent
  local temporary

  assert_relative_safe_path "$relative_target" active_pointer_invalid
  parent="$(dirname "$pointer")"
  mkdir -p "$parent"
  temporary="$parent/.active-pointer.$$.$RANDOM"
  rm -f "$temporary"
  ln -s "$relative_target" "$temporary"
  mv -f "$temporary" "$pointer"
  sync_filesystem
}

resolve_pointer() {
  local pointer="$1"
  local expected_root="$2"
  local label="$3"
  local target
  local resolved

  if [ ! -L "$pointer" ]; then
    fail "${label}_missing" "$pointer"
  fi
  target="$(readlink "$pointer")"
  if [[ "$target" = /* ]]; then
    fail "${label}_outside_root" "absolute target"
  fi
  assert_relative_safe_path "$target" "${label}_outside_root"
  if [ ! -e "$(dirname "$pointer")/$target" ]; then
    fail "${label}_target_missing" "$target"
  fi
  resolved="$(cd -P "$(dirname "$pointer")/$target" && pwd)"
  case "$resolved" in
    "$expected_root"/*) ;;
    *) fail "${label}_outside_root" "$resolved" ;;
  esac
  printf '%s\n' "$resolved"
}

verify_active_distribution() {
  local source_manifest="$1"
  local active

  if [ ! -f "$CONTRACT_PATH" ] || ! cmp -s "$source_manifest" "$CONTRACT_PATH"; then
    fail active_manifest_mismatch "$CONTRACT_PATH"
  fi
  active="$(resolve_pointer "$ACTIVE_NODE_POINTER" "$NODE_ROOT" active_pointer)"
  if [ "$active" != "$INSTALL_PATH" ]; then
    fail active_pointer_identity_mismatch "expected=${INSTALL_PATH} actual=${active}"
  fi
  verify_distribution_dir "$active" "$source_manifest"
  ACTIVE_INSTALL_PATH="$active"
}

install_distribution() {
  local source_manifest="$1"
  local archive_override="$2"
  local work_directory
  local archive
  local extract_root
  local payload
  local actual
  local install_parent
  local existing_real

  mkdir -p "$NODE_ROOT" "$RUNTIME_HOME/contracts"
  install_parent="$(dirname "$INSTALL_PATH")"
  mkdir -p "$install_parent"

  if [ -e "$INSTALL_PATH" ]; then
    if [ ! -d "$INSTALL_PATH" ]; then
      fail installation_incomplete "$INSTALL_PATH"
    fi
    existing_real="$(cd -P "$INSTALL_PATH" && pwd)"
    case "$existing_real" in
      "$NODE_ROOT"/*) ;;
      *) fail installation_outside_root "$existing_real" ;;
    esac
    [ "$existing_real" = "$INSTALL_PATH" ] || fail installation_outside_root "$existing_real"
    verify_distribution_dir "$INSTALL_PATH" "$source_manifest"
  else
    work_directory="$(mktemp -d "$install_parent/.install.XXXXXX")"
    TEMP_PATHS+=("$work_directory")
    archive="$work_directory/$ARCHIVE_FILENAME"
    extract_root="$work_directory/extract"
    mkdir -p "$extract_root"

    if [ -n "$archive_override" ]; then
      [ -f "$archive_override" ] || fail archive_missing "$archive_override"
      cp "$archive_override" "$archive"
    else
      command -v curl >/dev/null 2>&1 || fail download_tool_missing curl
      curl --fail --location --proto '=https' --tlsv1.2 --output "$archive" "$ARCHIVE_URL" || fail archive_download_failed "$ARCHIVE_URL"
    fi

    actual="$(sha256_file "$archive")"
    if [ "sha256:${actual}" != "$ARCHIVE_SHA256" ]; then
      fail archive_hash_mismatch "expected=${ARCHIVE_SHA256} actual=sha256:${actual}"
    fi
    validate_archive "$archive"
    tar -xzf "$archive" -C "$extract_root" --no-same-owner --no-same-permissions || fail archive_extract_failed
    payload="$extract_root/${ARCHIVE_FILENAME%.tar.gz}"
    [ -d "$payload" ] || fail archive_layout_invalid
    cp "$source_manifest" "$payload/manifest.json"
    verify_distribution_dir "$payload" "$source_manifest"

    LOCK_PATH="${INSTALL_PATH}.install-lock"
    if ! mkdir "$LOCK_PATH" 2>/dev/null; then
      fail install_lock_busy "$LOCK_PATH"
    fi
    if [ -e "$INSTALL_PATH" ]; then
      verify_distribution_dir "$INSTALL_PATH" "$source_manifest"
    else
      mv "$payload" "$INSTALL_PATH"
      sync_filesystem
    fi
    rmdir "$LOCK_PATH"
    LOCK_PATH=""
  fi

  atomic_copy "$source_manifest" "$CONTRACT_PATH" 644
  install_launcher_components
  set_relative_pointer "$ACTIVE_NODE_POINTER" "$INSTALL_RELATIVE_PATH"
  verify_active_distribution "$source_manifest"
}

assert_core_entry_relative() {
  local entry="$1"
  assert_relative_safe_path "$entry" core_entry_invalid
  [[ "$entry" =~ ^[A-Za-z0-9._/-]+$ ]] || fail core_entry_invalid "$entry"
}

write_core_binding() {
  local project_root="$1"
  local entry_relative="$2"
  local project_real
  local entry_real
  local entry_hash
  local canonical
  local binding_hash
  local binding_directory
  local binding_file
  local temporary

  assert_core_entry_relative "$entry_relative"
  [ -d "$project_root" ] || fail core_project_root_missing "$project_root"
  project_real="$(cd -P "$project_root" && pwd)"
  assert_plain_json_string project_root "$project_real"
  [ -f "$project_real/$entry_relative" ] || fail core_entry_missing "$project_real/$entry_relative"
  entry_real="$(resolve_self "$project_real/$entry_relative")"
  case "$entry_real" in
    "$project_real"/*) ;;
    *) fail core_entry_outside_project "$entry_real" ;;
  esac
  entry_hash="sha256:$(sha256_file "$entry_real")"
  canonical="{\"binding_kind\":\"development_checkout\",\"core_entry_relative_path\":\"${entry_relative}\",\"core_entry_sha256\":\"${entry_hash}\",\"format\":\"icarus.core-runtime-launch-binding/1\",\"managed_node_manifest_hash\":\"${MANIFEST_HASH}\",\"project_root\":\"${project_real}\"}"
  binding_hash="sha256:$(printf '%s\n%s' 'icarus:core-runtime-launch-binding:1' "$canonical" | sha256_stdin)"
  binding_directory="$RUNTIME_HOME/core-bindings/${binding_hash#sha256:}"
  binding_file="$binding_directory/binding.json"

  mkdir -p "$binding_directory"
  temporary="$(mktemp "$binding_directory/.binding.XXXXXX")"
  TEMP_PATHS+=("$temporary")
  printf '%s\n' \
    '{' \
    '  "format": "icarus.core-runtime-launch-binding/1",' \
    '  "binding_kind": "development_checkout",' \
    "  \"project_root\": \"${project_real}\"," \
    "  \"core_entry_relative_path\": \"${entry_relative}\"," \
    "  \"core_entry_sha256\": \"${entry_hash}\"," \
    "  \"managed_node_manifest_hash\": \"${MANIFEST_HASH}\"," \
    "  \"binding_hash\": \"${binding_hash}\"" \
    '}' > "$temporary"
  chmod 644 "$temporary"
  sync_filesystem

  if [ -f "$binding_file" ]; then
    if ! cmp -s "$temporary" "$binding_file"; then
      fail core_binding_collision "$binding_file"
    fi
    rm -f "$temporary"
  else
    mv "$temporary" "$binding_file"
    sync_filesystem
  fi
  set_relative_pointer "$ACTIVE_CORE_POINTER" "core-bindings/${binding_hash#sha256:}"
}

assert_core_binding_keyset() {
  local file="$1"
  local actual
  local expected
  actual="$(sed -nE 's/^[[:space:]]*"([^\"]+)"[[:space:]]*:.*/\1/p' "$file" | LC_ALL=C sort)"
  expected="$(printf '%s\n' binding_hash binding_kind core_entry_relative_path core_entry_sha256 format managed_node_manifest_hash project_root | LC_ALL=C sort)"
  [ "$actual" = "$expected" ] || fail core_binding_invalid "unexpected, duplicate, or missing field"
}

assert_core_binding_serialization() {
  local file="$1"
  local actual
  local expected
  local format="$2"
  local kind="$3"
  local project_root="$4"
  local entry_relative="$5"
  local entry_sha="$6"
  local manifest_hash="$7"
  local binding_hash="$8"

  actual="$(cat "$file")"
  expected="$(printf '%s\n' \
    '{' \
    '  "format": "'"${format}"'",' \
    '  "binding_kind": "'"${kind}"'",' \
    '  "project_root": "'"${project_root}"'",' \
    '  "core_entry_relative_path": "'"${entry_relative}"'",' \
    '  "core_entry_sha256": "'"${entry_sha}"'",' \
    '  "managed_node_manifest_hash": "'"${manifest_hash}"'",' \
    '  "binding_hash": "'"${binding_hash}"'"' \
    '}')"
  [ "$actual" = "$expected" ] || fail core_binding_invalid "non-canonical JSON document"
}

verify_core_binding() {
  local binding_directory
  local binding_file
  local format
  local kind
  local project_root
  local entry_relative
  local entry_sha
  local manifest_hash
  local binding_hash
  local canonical
  local calculated
  local entry_real

  binding_directory="$(resolve_pointer "$ACTIVE_CORE_POINTER" "$RUNTIME_HOME/core-bindings" active_core_pointer)"
  binding_file="$binding_directory/binding.json"
  [ -f "$binding_file" ] || fail core_binding_missing "$binding_file"
  assert_core_binding_keyset "$binding_file"
  format="$(json_string "$binding_file" format)"
  kind="$(json_string "$binding_file" binding_kind)"
  project_root="$(json_string "$binding_file" project_root)"
  entry_relative="$(json_string "$binding_file" core_entry_relative_path)"
  entry_sha="$(json_string "$binding_file" core_entry_sha256)"
  manifest_hash="$(json_string "$binding_file" managed_node_manifest_hash)"
  binding_hash="$(json_string "$binding_file" binding_hash)"

  assert_core_binding_serialization \
    "$binding_file" \
    "$format" \
    "$kind" \
    "$project_root" \
    "$entry_relative" \
    "$entry_sha" \
    "$manifest_hash" \
    "$binding_hash"

  [ "$format" = "icarus.core-runtime-launch-binding/1" ] || fail core_binding_invalid format
  [ "$kind" = "development_checkout" ] || fail core_binding_invalid binding_kind
  [ "$manifest_hash" = "$MANIFEST_HASH" ] || fail core_binding_manifest_mismatch
  [[ "$entry_sha" =~ ^sha256:[0-9a-f]{64}$ ]] || fail core_binding_invalid core_entry_sha256
  [[ "$binding_hash" =~ ^sha256:[0-9a-f]{64}$ ]] || fail core_binding_invalid binding_hash
  assert_core_entry_relative "$entry_relative"
  [ -d "$project_root" ] || fail core_project_root_missing "$project_root"
  project_root="$(cd -P "$project_root" && pwd)"

  canonical="{\"binding_kind\":\"${kind}\",\"core_entry_relative_path\":\"${entry_relative}\",\"core_entry_sha256\":\"${entry_sha}\",\"format\":\"${format}\",\"managed_node_manifest_hash\":\"${manifest_hash}\",\"project_root\":\"${project_root}\"}"
  calculated="sha256:$(printf '%s\n%s' 'icarus:core-runtime-launch-binding:1' "$canonical" | sha256_stdin)"
  [ "$calculated" = "$binding_hash" ] || fail core_binding_hash_mismatch "expected=${binding_hash} actual=${calculated}"
  [ "$(basename "$binding_directory")" = "${binding_hash#sha256:}" ] || fail core_binding_path_mismatch

  [ -f "$project_root/$entry_relative" ] || fail core_entry_missing "$project_root/$entry_relative"
  entry_real="$(resolve_self "$project_root/$entry_relative")"
  case "$entry_real" in
    "$project_root"/*) ;;
    *) fail core_entry_outside_project "$entry_real" ;;
  esac
  calculated="sha256:$(sha256_file "$entry_real")"
  [ "$calculated" = "$entry_sha" ] || fail core_entry_hash_mismatch "expected=${entry_sha} actual=${calculated}"
  CORE_ENTRY_PATH="$entry_real"
}

managed_exec() {
  local source_manifest="$1"
  local command
  shift
  [ "$#" -gt 0 ] || fail exec_command_missing
  verify_active_distribution "$source_manifest"
  unset NODE_OPTIONS NODE_PATH ICARUS_RUNTIME_HOME ICARUS_TOOLCHAIN_MANIFEST
  command="$1"
  shift
  case "$command" in
    node|npm|npx)
      command="$ACTIVE_INSTALL_PATH/bin/$command"
      ;;
  esac
  PATH="$ACTIVE_INSTALL_PATH/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin" exec "$command" "$@"
}

launcher_exec() {
  local installed_root
  local installed_manifest

  installed_root="$(cd -P "$SCRIPT_DIR/.." && pwd)"
  RUNTIME_HOME="$installed_root"
  installed_manifest="$RUNTIME_HOME/contracts/managed-node-runtime-distribution.json"
  load_manifest "$installed_manifest"
  runtime_layout "$RUNTIME_HOME"
  verify_active_distribution "$installed_manifest"
  verify_core_binding
  unset NODE_OPTIONS NODE_PATH ICARUS_RUNTIME_HOME ICARUS_TOOLCHAIN_MANIFEST
  PATH="$ACTIVE_INSTALL_PATH/bin:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin" exec "$ACTIVE_INSTALL_PATH/bin/node" "$CORE_ENTRY_PATH"
}

usage() {
  echo "Usage: scripts/runtime-toolchain.sh [--runtime-home PATH] [--manifest PATH] <install|verify|exec|active-path|bind-core>" >&2
  exit 64
}

if [ "${1:-}" = "launcher-exec" ]; then
  launcher_exec
fi

RUNTIME_HOME_ARG=""
MANIFEST_PATH="$DEFAULT_MANIFEST"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --runtime-home)
      [ "$#" -ge 2 ] || usage
      RUNTIME_HOME_ARG="$2"
      shift 2
      ;;
    --manifest)
      [ "$#" -ge 2 ] || usage
      MANIFEST_PATH="$2"
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

load_manifest "$MANIFEST_PATH"
runtime_layout "$RUNTIME_HOME_ARG"

case "$COMMAND" in
  install)
    ARCHIVE_OVERRIDE=""
    if [ "$#" -gt 0 ]; then
      [ "$#" -eq 2 ] && [ "$1" = "--archive" ] || usage
      ARCHIVE_OVERRIDE="$2"
    fi
    install_distribution "$MANIFEST_PATH" "$ARCHIVE_OVERRIDE"
    printf 'managed_node_path=%s\n' "$ACTIVE_INSTALL_PATH/bin/node"
    printf 'managed_node_version=v%s\n' "$NODE_VERSION"
    printf 'managed_npm_version=%s\n' "$NPM_VERSION"
    printf 'managed_manifest_hash=%s\n' "$MANIFEST_HASH"
    ;;
  verify)
    [ "$#" -eq 0 ] || usage
    verify_active_distribution "$MANIFEST_PATH"
    printf 'managed_node_path=%s\n' "$ACTIVE_INSTALL_PATH/bin/node"
    printf 'managed_node_version=v%s\n' "$NODE_VERSION"
    printf 'managed_npm_version=%s\n' "$NPM_VERSION"
    printf 'managed_manifest_hash=%s\n' "$MANIFEST_HASH"
    ;;
  active-path)
    [ "$#" -eq 0 ] || usage
    verify_active_distribution "$MANIFEST_PATH"
    printf '%s\n' "$ACTIVE_INSTALL_PATH"
    ;;
  exec)
    [ "${1:-}" = "--" ] || usage
    shift
    managed_exec "$MANIFEST_PATH" "$@"
    ;;
  bind-core)
    PROJECT_ROOT_ARG=""
    ENTRY_RELATIVE="dist/index.js"
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --project-root)
          [ "$#" -ge 2 ] || usage
          PROJECT_ROOT_ARG="$2"
          shift 2
          ;;
        --entry)
          [ "$#" -ge 2 ] || usage
          ENTRY_RELATIVE="$2"
          shift 2
          ;;
        *) usage ;;
      esac
    done
    [ -n "$PROJECT_ROOT_ARG" ] || usage
    verify_active_distribution "$MANIFEST_PATH"
    install_launcher_components
    write_core_binding "$PROJECT_ROOT_ARG" "$ENTRY_RELATIVE"
    verify_core_binding
    printf 'runtime_launcher=%s\n' "$RUNTIME_LAUNCHER_PATH"
    printf 'core_binding_kind=development_checkout\n'
    ;;
  *) usage ;;
esac
