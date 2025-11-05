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
**Session ID**: \`$SESSION_ID\`
**Started**: $(date '+%Y-%m-%d %H:%M:%S')
**Working Directory**: \`$CWD\`
**Search Pattern**:

---

EOF
fi

# Extract the search pattern from the frontmatter
SEARCH_PATTERN=""
if [[ -f "$MAIN_TRANSCRIPT" ]]; then
    SEARCH_PATTERN=$(grep -m 1 '^\*\*Search Pattern\*\*: ' "$MAIN_TRANSCRIPT" | sed 's/^\*\*Search Pattern\*\*: //' || echo "")
fi

# Debug: Log search pattern and sample JSONL
DEBUG_LOG="$TRANSCRIPT_DIR/debug.log"
echo "=== Debug $(date) ===" >> "$DEBUG_LOG"
echo "USER_PROMPT: [$USER_PROMPT]" >> "$DEBUG_LOG"
echo "Search pattern: [$SEARCH_PATTERN]" >> "$DEBUG_LOG"
echo "First user message in JSONL:" >> "$DEBUG_LOG"
(grep -m 1 '"type":"user"' "$TRANSCRIPT_PATH" | jq -r '.message.content | if type == "array" then .[0].text else . end' >> "$DEBUG_LOG" 2>&1) || echo "(no user messages)" >> "$DEBUG_LOG"
echo "Last user message in JSONL:" >> "$DEBUG_LOG"
(grep '"type":"user"' "$TRANSCRIPT_PATH" | tail -1 | jq -r '.message.content | if type == "array" then .[0].text else . end' >> "$DEBUG_LOG" 2>&1) || echo "(no user messages)" >> "$DEBUG_LOG"

# Create temp file for new content
TEMP_OUTPUT=$(mktemp)

# Add the current user prompt FIRST (it goes at the very top)
if [[ -n "$USER_PROMPT" ]]; then
    echo "**User:** <span style=\"color: green;\">$USER_PROMPT</span><br>" >> "$TEMP_OUTPUT"
fi

# Find all messages in JSONL that come after the last user prompt in transcript
FOUND_LAST_MATCH=false
SHOULD_COLLECT=false

# If transcript is empty (no search pattern), collect everything
if [[ -z "$SEARCH_PATTERN" ]]; then
    SHOULD_COLLECT=true
fi

echo "About to read JSONL from: $TRANSCRIPT_PATH" >> "$DEBUG_LOG"
echo "File exists: $(test -f "$TRANSCRIPT_PATH" && echo "yes" || echo "no")" >> "$DEBUG_LOG"
echo "File size: $(wc -c < "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")" >> "$DEBUG_LOG"

# Read JSONL from beginning to find where to start collecting
while IFS= read -r line; do
    if [[ -z "$line" ]]; then
        continue
    fi

    ENTRY_TYPE=$(echo "$line" | jq -r '.type // empty')

    # If we haven't found our starting point yet
    if [[ "$SHOULD_COLLECT" == "false" ]]; then
        # Look for the last user prompt using the search pattern
        if [[ "$ENTRY_TYPE" == "user" ]]; then
            # User content can be either a string or an array of content blocks
            USER_TEXT=$(echo "$line" | jq -r '.message.content | if type == "array" then .[0].text else . end' || echo "")

            # Check if pattern contains separator (long prompt)
            if [[ "$SEARCH_PATTERN" == *"|||"* ]]; then
                # Split pattern into start and end
                PATTERN_START="${SEARCH_PATTERN%|||*}"
                PATTERN_END="${SEARCH_PATTERN#*|||}"
                # Match if text starts with first 50 and ends with last 50
                if [[ "$USER_TEXT" == "$PATTERN_START"* ]] && [[ "$USER_TEXT" == *"$PATTERN_END" ]]; then
                    # Found the previous prompt, start collecting after it
                    SHOULD_COLLECT=true
                fi
            else
                # Short prompt - exact match
                if [[ "$USER_TEXT" == "$SEARCH_PATTERN" ]]; then
                    # Found the previous prompt, start collecting after it
                    SHOULD_COLLECT=true
                fi
            fi
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
                        echo "**Assistant:** $TEXT" >> "$TEMP_OUTPUT"
                    fi
                elif [[ "$BLOCK_TYPE" == "tool_use" ]]; then
                    TOOL_NAME=$(echo "$block" | jq -r '.name // empty')
                    TOOL_USE_ID=$(echo "$block" | jq -r '.id // empty')
                    TOOL_INPUT=$(echo "$block" | jq -c '.input')

                    echo "<details>" >> "$TEMP_OUTPUT"
                    echo "<summary>🔧 <strong>$TOOL_NAME</strong></summary>" >> "$TEMP_OUTPUT"
                    echo "" >> "$TEMP_OUTPUT"
                    echo "**Input:**" >> "$TEMP_OUTPUT"
                    echo '```json' >> "$TEMP_OUTPUT"
                    echo "$TOOL_INPUT" | jq '.' >> "$TEMP_OUTPUT"
                    echo '```' >> "$TEMP_OUTPUT"

                    # Find the matching tool result
                    TOOL_OUTPUT=$(grep "\"tool_use_id\":\"$TOOL_USE_ID\"" "$TRANSCRIPT_PATH" | head -1 | jq -r '.message.content[0].content // empty')
                    if [[ -n "$TOOL_OUTPUT" ]]; then
                        echo "" >> "$TEMP_OUTPUT"
                        echo "**Output:**" >> "$TEMP_OUTPUT"
                        echo '```' >> "$TEMP_OUTPUT"
                        echo "$TOOL_OUTPUT" >> "$TEMP_OUTPUT"
                        echo '```' >> "$TEMP_OUTPUT"
                    fi

                    echo "</details>" >> "$TEMP_OUTPUT"
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
    # Create search pattern: first 50 chars ||| last 50 chars
    # This uniquely identifies the prompt even if it's very long
    PROMPT_LEN=${#USER_PROMPT}
    if [[ $PROMPT_LEN -le 100 ]]; then
        NEW_SEARCH_PATTERN="$USER_PROMPT"
    else
        FIRST_50="${USER_PROMPT:0:50}"
        LAST_50="${USER_PROMPT: -50}"
        NEW_SEARCH_PATTERN="${FIRST_50}|||${LAST_50}"
    fi

    cat > "$MAIN_TRANSCRIPT.tmp" << EOF
# Claude Code Session
**Session ID**: \`$SESSION_ID\`
**Started**: $(grep -m 1 '^\*\*Started\*\*:' "$MAIN_TRANSCRIPT" | sed 's/^\*\*Started\*\*: //')
**Working Directory**: \`$CWD\`
**Search Pattern**: $NEW_SEARCH_PATTERN

---

EOF

    # Add new content
    cat "$TEMP_OUTPUT" >> "$MAIN_TRANSCRIPT.tmp"

    # Read existing content (everything after the old header and separator)
    # Header is now 7 lines (title + 4 fields + blank + separator)
    EXISTING_CONTENT=""
    if [[ $(wc -l < "$MAIN_TRANSCRIPT") -gt 7 ]]; then
        EXISTING_CONTENT=$(tail -n +8 "$MAIN_TRANSCRIPT")
    fi

    if [[ -n "$EXISTING_CONTENT" ]]; then
        echo "$EXISTING_CONTENT" >> "$MAIN_TRANSCRIPT.tmp"
    fi

    mv "$MAIN_TRANSCRIPT.tmp" "$MAIN_TRANSCRIPT"
fi

# Clean up
rm -f "$TEMP_OUTPUT"

exit 0
