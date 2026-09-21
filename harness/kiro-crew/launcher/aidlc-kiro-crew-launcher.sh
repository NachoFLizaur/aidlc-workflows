#!/bin/sh
# Prefer the selected stamped project engine with Bun, then native aidlc.
# The App Kit has no second engine. MCP requires Bun even with native aidlc.
set -eu

fail() { printf '%s\n' "AI-DLC Kiro Crew: $*" >&2; exit 1; }
install_docs='docs/guide/01-getting-started.md and docs/guide/18-install-and-lifecycle.md (https://github.com/awslabs/aidlc-workflows/tree/main/docs/guide)'
project=${AIDLC_PROJECT_DIR-${PWD}}
[ -n "$project" ] || fail 'AIDLC_PROJECT_DIR is empty. Select a project and complete project setup.'
case "$project" in /*) ;; *) project=$PWD/$project ;; esac
stamp=$project/.kiro-crew/tools/data/aidlc-stamp.json
setup_error="expected a kiro-crew projection stamp at $stamp. Select the project cwd or set AIDLC_PROJECT_DIR and complete project setup."
[ -r "$stamp" ] && [ -f "$stamp" ] || fail "Missing stamp: $setup_error"

# Read the project installation stamp before any child can mutate state.
# Shell builtins validate exactly four flat literal fields without requiring
# another runtime. Unknown/duplicate fields, escapes, nesting and mismatches
# stop, without bypass. Identity is not authenticity against engine writers.
valid_stamp() {
  compact= quoted=0
  while IFS= read -r line || [ -n "$line" ]; do
    while [ -n "$line" ]; do
      rest=${line#?}
      char=${line%"$rest"}
      line=$rest
      case "$char" in
        '\') return 1 ;;
        '"') quoted=$((1 - quoted)) ;;
        [[:space:]]) if [ "$quoted" -eq 0 ]; then continue; fi ;;
      esac
      compact=$compact$char
    done
    [ "$quoted" -eq 0 ] || return 1
  done < "$stamp"
  case "$compact" in '{'*'}') ;; *) return 1 ;; esac
  fields=${compact#\{}
  fields=${fields%\}}
  schema= distribution= harness= version=
  while :; do
    field=${fields%%,*}
    case "$field" in
      '"schemaVersion":1') [ -z "$schema" ] || return 1; schema=1 ;;
      '"distribution":"kiro-crew"') [ -z "$distribution" ] || return 1; distribution=1 ;;
      '"harnessDir":".kiro-crew"') [ -z "$harness" ] || return 1; harness=1 ;;
      '"frameworkVersion":"'*'"')
        [ -z "$version" ] || return 1
        value=${field#'"frameworkVersion":"'}
        value=${value%'"'}
        case "$value" in ''|*[!0-9a-z.-]*) return 1 ;; esac
        version=1
        ;;
      *) return 1 ;;
    esac
    [ "$fields" != "$field" ] || break
    fields=${fields#*,}
  done
  [ "$schema$distribution$harness$version" = 1111 ]
}
valid_stamp || fail "Invalid or mismatched stamp: $setup_error"

export AIDLC_PROJECT_DIR="$project"
export AIDLC_HARNESS_DIR=.kiro-crew
export AIDLC_HARNESS_NAME=kiro-crew

# Check PATH before exec. No runtime fails visibly; selected-runtime failure
# passes through unchanged, never retried through another runtime.
if command -v bun >/dev/null 2>&1; then
  if [ "${1-}" = mcp ]; then
    shift
    self=$0
    case "$self" in */*) ;; *) self=$(command -v "$self") ;; esac
    app_dir=${self%/*}
    exec bun "$app_dir/mcp/aidlc-mcp-bridge.ts" "$@"
  fi
  engine=$project/.kiro-crew/tools/aidlc.ts
  [ -f "$engine" ] || fail "Missing project engine $engine. Repeat project setup; see $install_docs."
  exec bun "$engine" "$@"
fi
if [ "${1-}" = mcp ]; then
  fail "MCP bridge requires bun on PATH; native aidlc alone cannot run the bridge. Install Bun; see $install_docs."
fi
if command -v aidlc >/dev/null 2>&1; then
  exec aidlc "$@"
fi
fail "No runtime on PATH: install bun (project TypeScript engine) or aidlc (native binary). See $install_docs."
