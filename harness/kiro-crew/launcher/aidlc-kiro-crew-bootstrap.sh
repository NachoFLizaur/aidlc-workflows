#!/bin/sh
# Resolve the installed App Kit, never the project. Setup supplies absolute
# registered paths; the launcher independently validates project selection.
set -eu

crew_home=${KIROCREW_HOME:-${HOME:?Set HOME or KIROCREW_HOME to locate the installed aidlc app}/.kiro/crew}
launcher=$crew_home/apps/aidlc/aidlc-kiro-crew-launcher.sh
# Check the declared installed executable before exec. Missing app stops;
# no cwd fallback or disabling flag exists.
if [ ! -x "$launcher" ]; then
  printf '%s\n' "AI-DLC Kiro Crew: missing executable $launcher. Install/register the aidlc App Kit and complete project setup; check KIROCREW_HOME or use an absolute launcher path at setup." >&2
  exit 1
fi
exec "$launcher" "$@"
