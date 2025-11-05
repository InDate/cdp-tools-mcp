#!/bin/bash

# Read the JSON input from stdin
INPUT=$(cat)

# Log the raw input to a debug file
echo "=== Debug Hook $(date) ===" >> /tmp/hook-debug.log
echo "$INPUT" | jq '.' >> /tmp/hook-debug.log
echo "---" >> /tmp/hook-debug.log

# Always allow
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
exit 0
