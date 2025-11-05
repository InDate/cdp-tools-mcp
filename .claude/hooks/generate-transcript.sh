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

# Setup transcript directory
TRANSCRIPT_DIR="$CWD/.claude/transcripts"
mkdir -p "$TRANSCRIPT_DIR"

# Validate required inputs
if [[ -z "$TRANSCRIPT_PATH" ]] || [[ -z "$SESSION_ID" ]]; then
    exit 0
fi

# Check if transcript file exists
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    exit 0
fi

# Only process UserPromptSubmit and SessionEnd events
if [[ "$HOOK_EVENT" != "UserPromptSubmit" ]] && [[ "$HOOK_EVENT" != "SessionEnd" ]]; then
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

# Find the user prompt to collect responses after
# For SessionEnd: get the last (first when reading backwards) user prompt
# For UserPromptSubmit: get the second-to-last (skip current, get previous)
PREVIOUS_USER_PROMPT=""
PREVIOUS_USER_LINE=""

USER_COUNT=0
TARGET_COUNT=1  # For SessionEnd, we want the first user prompt
if [[ "$HOOK_EVENT" == "UserPromptSubmit" ]]; then
    TARGET_COUNT=2  # For UserPromptSubmit, we want the second user prompt
fi

while IFS= read -r line; do
    if [[ -z "$line" ]]; then
        continue
    fi

    ENTRY_TYPE=$(echo "$line" | jq -r '.type // empty')

    if [[ "$ENTRY_TYPE" == "user" ]]; then
        USER_COUNT=$((USER_COUNT + 1))
        if [[ $USER_COUNT -eq $TARGET_COUNT ]]; then
            # Found the target user prompt
            PREVIOUS_USER_PROMPT=$(echo "$line" | jq -r '.message.content | if type == "array" then .[0].text else . end' || echo "")
            # Skip only if null or empty (keep all valid prompts including interrupted ones)
            if [[ -n "$PREVIOUS_USER_PROMPT" ]] && [[ "$PREVIOUS_USER_PROMPT" != "null" ]]; then
                PREVIOUS_USER_LINE="$line"
                break
            fi
            # Reset counter to keep looking for a valid prompt at target position
            USER_COUNT=$((TARGET_COUNT - 1))
        fi
    fi
done < <(tail -r "$TRANSCRIPT_PATH" 2>/dev/null || sed '1!G;h;$!d' "$TRANSCRIPT_PATH")

# Create temp file for new content
TEMP_OUTPUT=$(mktemp)

# Add the current user prompt to temp output (this goes at the top)
# Skip for SessionEnd events as they don't have a new user prompt
if [[ "$HOOK_EVENT" == "UserPromptSubmit" ]] && [[ -n "$USER_PROMPT" ]]; then
    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
    echo "**User ($TIMESTAMP):** <span style=\"color: green;\">$USER_PROMPT</span><br>" >> "$TEMP_OUTPUT"
    echo "" >> "$TEMP_OUTPUT"
fi

# Collect assistant responses to insert into old content
ASSISTANT_RESPONSES=$(mktemp)
WAS_INTERRUPTED=false

# For SessionEnd, we need to collect responses after the last user prompt
# For UserPromptSubmit, we collect after the previous user prompt
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
            # Check if this response was interrupted
            STOP_REASON=$(echo "$line" | jq -r '.message.stop_reason // empty')
            if [[ "$STOP_REASON" == "null" ]] || [[ -z "$STOP_REASON" ]]; then
                WAS_INTERRUPTED=true
            fi

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

# Prepend new content to the top of the file (after header)
# For SessionEnd, we process even if TEMP_OUTPUT is empty (just adding assistant responses)
if [[ -s "$TEMP_OUTPUT" ]] || [[ "$HOOK_EVENT" == "SessionEnd" ]]; then
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
        if [[ "$HOOK_EVENT" == "UserPromptSubmit" ]]; then
            # For UserPromptSubmit: add separator, then previous prompt + responses
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

                # Add status indicator
                if [[ "$HOOK_EVENT" == "SessionEnd" ]]; then
                    TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                    echo "<span style=\"color: blue;\">**[Session Ended: $TIMESTAMP]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                    echo "" >> "$MAIN_TRANSCRIPT.tmp"
                elif [[ "$WAS_INTERRUPTED" == "true" ]]; then
                    echo "<span style=\"color: red;\">**[Interrupted]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                    echo "" >> "$MAIN_TRANSCRIPT.tmp"
                fi
            fi

            # Write the rest of the old content (skip first 2 lines which is the old prompt + blank)
            echo "$EXISTING_CONTENT" | tail -n +3 >> "$MAIN_TRANSCRIPT.tmp"
        else
            # For SessionEnd: just append assistant responses to the existing first section
            # Insert assistant responses right after the existing content's first user prompt
            # We need to parse EXISTING_CONTENT and insert after the first user prompt line

            # Find the first user prompt line in existing content
            FIRST_USER_LINE=$(echo "$EXISTING_CONTENT" | grep -n "^\*\*User" | head -1 | cut -d: -f1)

            if [[ -n "$FIRST_USER_LINE" ]]; then
                # Split content: lines 1 to FIRST_USER_LINE, then assistant responses, then rest
                echo "$EXISTING_CONTENT" | head -n $((FIRST_USER_LINE + 1)) >> "$MAIN_TRANSCRIPT.tmp"

                # Insert assistant responses
                if [[ -s "$ASSISTANT_RESPONSES" ]]; then
                    cat "$ASSISTANT_RESPONSES" >> "$MAIN_TRANSCRIPT.tmp"

                    # Add status indicator
                    if [[ "$HOOK_EVENT" == "SessionEnd" ]]; then
                        TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                        echo "<span style=\"color: blue;\">**[Session Ended: $TIMESTAMP]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                        echo "" >> "$MAIN_TRANSCRIPT.tmp"
                    elif [[ "$WAS_INTERRUPTED" == "true" ]]; then
                        echo "<span style=\"color: red;\">**[Interrupted]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                        echo "" >> "$MAIN_TRANSCRIPT.tmp"
                    fi
                fi

                # Add rest of existing content (skip first FIRST_USER_LINE+1 lines)
                echo "$EXISTING_CONTENT" | tail -n +$((FIRST_USER_LINE + 2)) >> "$MAIN_TRANSCRIPT.tmp"
            else
                # No user prompt found, just append everything
                echo "$EXISTING_CONTENT" >> "$MAIN_TRANSCRIPT.tmp"

                if [[ -s "$ASSISTANT_RESPONSES" ]]; then
                    cat "$ASSISTANT_RESPONSES" >> "$MAIN_TRANSCRIPT.tmp"

                    # Add status indicator
                    if [[ "$HOOK_EVENT" == "SessionEnd" ]]; then
                        TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')
                        echo "<span style=\"color: blue;\">**[Session Ended: $TIMESTAMP]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                        echo "" >> "$MAIN_TRANSCRIPT.tmp"
                    elif [[ "$WAS_INTERRUPTED" == "true" ]]; then
                        echo "<span style=\"color: red;\">**[Interrupted]**</span>" >> "$MAIN_TRANSCRIPT.tmp"
                        echo "" >> "$MAIN_TRANSCRIPT.tmp"
                    fi
                fi
            fi
        fi
    fi

    # Clean up temp file
    rm -f "$ASSISTANT_RESPONSES"

    mv "$MAIN_TRANSCRIPT.tmp" "$MAIN_TRANSCRIPT"
fi

# Clean up
rm -f "$TEMP_OUTPUT"

exit 0
