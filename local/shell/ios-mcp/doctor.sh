#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
source "$SCRIPT_DIR/common.sh"

failures=0
warnings=0

check_required_command() {
  local command="$1"
  if command -v "$command" >/dev/null 2>&1; then
    print_check "$command: $(command -v "$command")"
  else
    print_fail "$command not found in PATH"
    failures=$((failures + 1))
  fi
}

check_optional_command() {
  local command="$1"
  if command -v "$command" >/dev/null 2>&1; then
    print_check "$command: $(command -v "$command")"
  else
    print_warn "$command not found in PATH"
    warnings=$((warnings + 1))
  fi
}

echo "iOS MCP doctor"
echo "service: $DEFAULT_SERVICE"
echo

if [ ! -f "$SERVICES_JSON" ]; then
  print_fail "services.json not found: $SERVICES_JSON"
  exit 1
fi
print_check "services.json: $SERVICES_JSON"

check_required_command node
check_required_command xcodebuild
check_required_command xcrun
check_required_command appium
check_optional_command flutter
check_optional_command pod

echo
echo "Xcode"
if developer_dir="$(xcode-select -p 2>/dev/null)"; then
  print_check "developer dir: $developer_dir"
else
  print_fail "xcode-select -p failed"
  failures=$((failures + 1))
fi

if xcodebuild -checkFirstLaunchStatus >/dev/null 2>&1; then
  print_check "xcode first launch completed"
else
  print_fail "xcode first launch is not completed"
  failures=$((failures + 1))
fi

echo
echo "Simulator"
simulator_name="$(json_value 'ios.simulator || "iPhone 17"')"
if xcrun simctl list devices available --json >/tmp/icarus-ios-mcp-simctl.json 2>/tmp/icarus-ios-mcp-simctl.err; then
  if node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/icarus-ios-mcp-simctl.json', 'utf8'));
const wanted = process.argv[1];
const devices = Object.values(data.devices || {}).flat();
const found = devices.find((item) => item.name === wanted);
process.exit(found ? 0 : 1);
" "$simulator_name"; then
    print_check "simulator available: $simulator_name"
  else
    print_fail "simulator not available: $simulator_name"
    failures=$((failures + 1))
  fi
else
  print_fail "xcrun simctl list failed: $(cat /tmp/icarus-ios-mcp-simctl.err)"
  failures=$((failures + 1))
fi

echo
echo "Appium"
if appium --version >/tmp/icarus-ios-mcp-appium-version.txt 2>/tmp/icarus-ios-mcp-appium-version.err; then
  print_check "appium version: $(cat /tmp/icarus-ios-mcp-appium-version.txt)"
else
  print_fail "appium --version failed: $(cat /tmp/icarus-ios-mcp-appium-version.err)"
  failures=$((failures + 1))
fi

if appium driver list --installed --json >/tmp/icarus-ios-mcp-appium-drivers.json 2>/tmp/icarus-ios-mcp-appium-drivers.err; then
  if node -e "
const fs = require('fs');
const drivers = JSON.parse(fs.readFileSync('/tmp/icarus-ios-mcp-appium-drivers.json', 'utf8'));
process.exit(drivers.xcuitest && drivers.xcuitest.installed ? 0 : 1);
"; then
    print_check "appium xcuitest driver installed"
  else
    print_fail "appium xcuitest driver is not installed"
    failures=$((failures + 1))
  fi
else
  print_fail "appium driver list failed: $(cat /tmp/icarus-ios-mcp-appium-drivers.err)"
  failures=$((failures + 1))
fi

appium_url="$(json_value 'ios.automation && ios.automation.appium_server_url || "http://127.0.0.1:4723"')"
if curl -fsS --max-time 2 "$appium_url/status" >/dev/null 2>&1; then
  print_check "appium server healthy: $appium_url"
else
  print_warn "appium server is not running: $appium_url"
  print_warn "start it with: local/shell/appium/start.sh"
  warnings=$((warnings + 1))
fi

echo
echo "Service iOS config"
repo_dir="$(ios_repo_dir)"
workspace="$(json_value 'ios.workspace || ""')"
scheme="$(json_value 'ios.scheme || ""')"
configuration="$(json_value 'ios.configuration || "Debug"')"
bundle_id="$(json_value 'ios.bundle_id || ""')"
app_name="$(json_value 'ios.app_name || ""')"

if [ -d "$repo_dir" ]; then
  print_check "iOS repo: $repo_dir"
else
  print_fail "iOS repo missing: $repo_dir"
  failures=$((failures + 1))
fi

if [ -n "$workspace" ] && [ -d "$repo_dir/$workspace" ]; then
  print_check "workspace: $workspace"
else
  print_fail "workspace missing: $workspace"
  failures=$((failures + 1))
fi

if [ -n "$scheme" ]; then
  print_check "scheme: $scheme"
else
  print_fail "scheme is empty"
  failures=$((failures + 1))
fi
print_check "configuration: $configuration"
print_check "bundle id: $bundle_id"
if [ -n "$app_name" ]; then
  print_check "app name: $app_name"
else
  print_warn "app_name not configured; build will infer a single .app from products"
  warnings=$((warnings + 1))
fi

if [ -d "$repo_dir" ] && [ -n "$workspace" ] && [ -d "$repo_dir/$workspace" ]; then
  if (
    cd "$repo_dir"
    xcodebuild -list -workspace "$workspace"
  ) >/tmp/icarus-ios-mcp-xcode-list.txt 2>/tmp/icarus-ios-mcp-xcode-list.err; then
    if grep -Eq "^[[:space:]]+$scheme$" /tmp/icarus-ios-mcp-xcode-list.txt; then
      print_check "scheme exists in workspace"
    else
      print_fail "scheme not listed by xcodebuild: $scheme"
      failures=$((failures + 1))
    fi
  else
    print_fail "xcodebuild -list failed: $(cat /tmp/icarus-ios-mcp-xcode-list.err)"
    failures=$((failures + 1))
  fi
fi

if [ -d "$repo_dir" ] && [ -f "$repo_dir/pubspec.cn.yaml" ] && [ ! -f "$repo_dir/pubspec.yaml" ]; then
  print_warn "pubspec.yaml missing; prepare Flutter env before build: local/shell/ios-mcp/prepare-catstory-cn.sh"
  warnings=$((warnings + 1))
fi

if [ -d "$repo_dir" ] && [ ! -f "$repo_dir/ios/Flutter/Generated.xcconfig" ]; then
  print_warn "ios/Flutter/Generated.xcconfig missing; run Flutter dependency preparation before build"
  warnings=$((warnings + 1))
fi

plugins_file="$repo_dir/.flutter-plugins-dependencies"
if [ -f "$plugins_file" ]; then
  if node -e "
const fs = require('fs');
const data = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
process.exit(data.swift_package_manager_enabled && data.swift_package_manager_enabled.ios === true ? 1 : 0);
" "$plugins_file"; then
    print_check "Flutter iOS Swift Package Manager disabled for xcodebuild path"
  else
    print_warn "Flutter iOS Swift Package Manager is enabled; run local/shell/ios-mcp/prepare-catstory-cn.sh before xcodebuild"
    warnings=$((warnings + 1))
  fi
fi

echo
echo "summary: failures=$failures warnings=$warnings"
if [ "$failures" -gt 0 ]; then
  exit 1
fi
