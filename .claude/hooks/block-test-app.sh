#!/bin/bash

# Read the JSON input from stdin
INPUT=$(cat)

# Extract the file path parameter from tool_input
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // .tool_input.notebook_path // empty')

# Extract command parameter for Bash tool
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Extract transcript path to check for password in recent conversation
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')

# Password for override
PASSWORD="Password"

# Check if password is in recent transcript (last 10 messages)
if [ -n "$TRANSCRIPT_PATH" ] && [ -f "$TRANSCRIPT_PATH" ]; then
    if tail -10 "$TRANSCRIPT_PATH" | grep -q "$PASSWORD"; then
        echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
        exit 0
    fi
fi

# Block access to this hook file itself (so Claude can't read the password)
if [[ "$FILE_PATH" == *".claude/hooks/block-test-app.sh"* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Access to this hook file is restricted"}}'
    exit 2
fi

# Block access to test-app directory (check both file path and command)
if [[ "$FILE_PATH" == *"test-app"* ]] || [[ "$COMMAND" == *"test-app"* ]]; then
    echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Access to test-app directory is restricted. Provide the password to override."}}'
    exit 2
fi

# Allow all other operations
echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}'
exit 0
