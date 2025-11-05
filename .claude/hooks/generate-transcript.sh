#!/bin/bash
set -euo pipefail

# Read JSON input from stdin
INPUT=$(cat)

# Extract required fields
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')
HOOK_EVENT=$(echo "$INPUT" | jq -r '.hook_event_name // empty')
USER_PROMPT=$(echo "$INPUT" | jq -r '.prompt // empty')

# Setup error logging
TRANSCRIPT_DIR="$CWD/.claude/transcripts"
mkdir -p "$TRANSCRIPT_DIR"
ERROR_LOG="$TRANSCRIPT_DIR/error.log"

# Redirect all errors to error log
exec 2>>"$ERROR_LOG"
echo "=== Script run at $(date) ===" >&2
echo "SESSION_ID: $SESSION_ID" >&2
echo "USER_PROMPT: $USER_PROMPT" >&2
echo "TRANSCRIPT_PATH: $TRANSCRIPT_PATH" >&2

# Validate required inputs
if [[ -z "$TRANSCRIPT_PATH" ]] || [[ -z "$SESSION_ID" ]]; then
    exit 0
fi

# Check if transcript file exists
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    exit 0
fi

# Only process UserPromptSubmit events
if [[ "$HOOK_EVENT" != "UserPromptSubmit" ]]; then
    echo "Skipping: not a UserPromptSubmit event" >&2
    exit 0
fi

# File paths
MAIN_TRANSCRIPT="$TRANSCRIPT_DIR/${SESSION_ID}.md"

# If this is a new session (no transcript file exists), create header
if [[ ! -f "$MAIN_TRANSCRIPT" ]]; then
    cat > "$MAIN_TRANSCRIPT" << EOF
# Claude Code Session

**Session ID**: \`$SESSION_ID\`<br>
**Started**: $(date '+%Y-%m-%d %H:%M:%S')<br>
**Working Directory**: \`$CWD\`<br>

---

EOF
fi

# Find the second-to-last user prompt from JSONL by reading backwards
PREVIOUS_USER_PROMPT=""
PREVIOUS_USER_LINE=""

# Read backwards, skip first user prompt (current), get second (previous)
USER_COUNT=0
while IFS= read -r line; do
    if [[ -z "$line" ]]; then
        continue
    fi

    ENTRY_TYPE=$(echo "$line" | jq -r '.type // empty')

    if [[ "$ENTRY_TYPE" == "user" ]]; then
        USER_COUNT=$((USER_COUNT + 1))
        if [[ $USER_COUNT -eq 2 ]]; then
            # Found the second-to-last user prompt
            PREVIOUS_USER_PROMPT=$(echo "$line" | jq -r '.message.content | if type == "array" then .[0].text else . end' || echo "")
            # Skip only if null or empty (keep all valid prompts including interrupted ones)
            if [[ -n "$PREVIOUS_USER_PROMPT" ]] && [[ "$PREVIOUS_USER_PROMPT" != "null" ]]; then
                PREVIOUS_USER_LINE="$line"
                break
            fi
            # Reset counter to keep looking for a valid second prompt
            USER_COUNT=1
        fi
    fi
done < <(tail -r "$TRANSCRIPT_PATH" 2>/dev/null || sed '1!G;h;$!d' "$TRANSCRIPT_PATH")

# Debug logging
DEBUG_LOG="$TRANSCRIPT_DIR/debug.log"
echo "=== Debug $(date) ===" >> "$DEBUG_LOG"
echo "USER_PROMPT: [$USER_PROMPT]" >> "$DEBUG_LOG"
echo "Previous user prompt: [$PREVIOUS_USER_PROMPT]" >> "$DEBUG_LOG"

# Create temp file for new content
TEMP_OUTPUT=$(mktemp)

# Add the current user prompt to temp output (this goes at the top)
if [[ -n "$USER_PROMPT" ]]; then
    echo "**User:** <span style=\"color: green;\">$USER_PROMPT</span><br>" >> "$TEMP_OUTPUT"
    echo "" >> "$TEMP_OUTPUT"
fi

# Collect assistant responses to insert into old content
ASSISTANT_RESPONSES=$(mktemp)
WAS_INTERRUPTED=false

# Now collect assistant responses after the previous user prompt
SHOULD_COLLECT=false
while IFS= read -r line; do
    if [[ -z "$line" ]]; then
        continue
    fi

    ENTRY_TYPE=$(echo "$line" | jq -r '.type // empty')

    # If we haven't found our starting point yet
    if [[ "$SHOULD_COLLECT" == "false" ]]; then
        # Check if this is the previous user prompt line
        if [[ -n "$PREVIOUS_USER_LINE" ]] && [[ "$line" == "$PREVIOUS_USER_LINE" ]]; then
            SHOULD_COLLECT=true
        fi
        # Don't collect this line, continue to next iteration
        continue
    else
        # We're collecting messages now
        if [[ "$ENTRY_TYPE" == "assistant" ]]; then
            # Process assistant message content
            echo "$line" | jq -c '.message.content[]?' | while IFS= read -r block; do
                BLOCK_TYPE=$(echo "$block" | jq -r '.type // empty')

                if [[ "$BLOCK_TYPE" == "text" ]]; then
                    TEXT=$(echo "$block" | jq -r '.text // empty')
                    if [[ -n "$TEXT" ]]; then
                        echo "**Assistant:** $TEXT" >> "$ASSISTANT_RESPONSES"
                        echo "" >> "$ASSISTANT_RESPONSES"
                    fi
                elif [[ "$BLOCK_TYPE" == "tool_use" ]]; then
                    TOOL_NAME=$(echo "$block" | jq -r '.name // empty')
                    TOOL_USE_ID=$(echo "$block" | jq -r '.id // empty')
                    TOOL_INPUT=$(echo "$block" | jq -c '.input')

                    echo "<details>" >> "$ASSISTANT_RESPONSES"
                    echo "<summary>🔧 <strong>$TOOL_NAME</strong></summary>" >> "$ASSISTANT_RESPONSES"
                    echo "" >> "$ASSISTANT_RESPONSES"
                    echo "**Input:**" >> "$ASSISTANT_RESPONSES"
                    echo '```json' >> "$ASSISTANT_RESPONSES"
                    echo "$TOOL_INPUT" | jq '.' >> "$ASSISTANT_RESPONSES"
                    echo '```' >> "$ASSISTANT_RESPONSES"

                    # Find the matching tool result
                    TOOL_OUTPUT=$(grep "\"tool_use_id\":\"$TOOL_USE_ID\"" "$TRANSCRIPT_PATH" | head -1 | jq -r '.message.content[0].content // empty')
                    if [[ -n "$TOOL_OUTPUT" ]]; then
                        echo "" >> "$ASSISTANT_RESPONSES"
                        echo "**Output:**" >> "$ASSISTANT_RESPONSES"
                        echo '```' >> "$ASSISTANT_RESPONSES"
                        echo "$TOOL_OUTPUT" >> "$ASSISTANT_RESPONSES"
                        echo '```' >> "$ASSISTANT_RESPONSES"
                    fi

                    echo "</details>" >> "$ASSISTANT_RESPONSES"
                    echo "<br>" >> "$ASSISTANT_RESPONSES"
                    echo "" >> "$ASSISTANT_RESPONSES"
                fi
            done
        fi
    fi

done < "$TRANSCRIPT_PATH"

# Debug: Check temp output
echo "TEMP_OUTPUT file: $TEMP_OUTPUT" >> "$DEBUG_LOG"
echo "TEMP_OUTPUT size: $(wc -c < "$TEMP_OUTPUT" 2>/dev/null || echo "0")" >> "$DEBUG_LOG"
echo "TEMP_OUTPUT content:" >> "$DEBUG_LOG"
cat "$TEMP_OUTPUT" >> "$DEBUG_LOG" 2>&1
echo "---" >> "$DEBUG_LOG"

# Prepend new content to the top of the file (after header)
if [[ -s "$TEMP_OUTPUT" ]]; then
    # Create temp file starting with existing header (first 8 lines)
    head -8 "$MAIN_TRANSCRIPT" > "$MAIN_TRANSCRIPT.tmp"

    # Add new content
    cat "$TEMP_OUTPUT" >> "$MAIN_TRANSCRIPT.tmp"

    # Read existing content (everything after the old header and separator)
    # Header is 8 lines (title + blank + 3 fields + blank + separator + blank)
    EXISTING_CONTENT=""
    if [[ $(wc -l < "$MAIN_TRANSCRIPT") -gt 8 ]]; then
        EXISTING_CONTENT=$(tail -n +9 "$MAIN_TRANSCRIPT")
    fi

    # Add separator and old content with assistant responses inserted
    if [[ -n "$EXISTING_CONTENT" ]]; then
        echo "---" >> "$MAIN_TRANSCRIPT.tmp"
        echo "" >> "$MAIN_TRANSCRIPT.tmp"

        # Write the previous user prompt
        if [[ -n "$PREVIOUS_USER_PROMPT" ]]; then
            echo "**User:** <span style=\"color: green;\">$PREVIOUS_USER_PROMPT</span><br>" >> "$MAIN_TRANSCRIPT.tmp"
            echo "" >> "$MAIN_TRANSCRIPT.tmp"
        fi

        # Insert assistant responses
        if [[ -s "$ASSISTANT_RESPONSES" ]]; then
            cat "$ASSISTANT_RESPONSES" >> "$MAIN_TRANSCRIPT.tmp"

            # Add interrupted indicator if this was an interrupted request
            if [[ "$PREVIOUS_USER_PROMPT" == "[Request interrupted by user]"* ]]; then
                echo "<span style=\"color: red;\">**[Interrupted]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                echo "" >> "$MAIN_TRANSCRIPT.tmp"
            fi
        fi

        # Write the rest of the old content (skip first 2 lines which is the old prompt + blank)
        echo "$EXISTING_CONTENT" | tail -n +3 >> "$MAIN_TRANSCRIPT.tmp"
    fi

    # Clean up temp file
    rm -f "$ASSISTANT_RESPONSES"

    mv "$MAIN_TRANSCRIPT.tmp" "$MAIN_TRANSCRIPT"
fi

# Clean up
rm -f "$TEMP_OUTPUT"

exit 0
