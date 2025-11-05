#!/bin/bash
set -euo pipefail

# Read JSON input from stdin
INPUT=$(cat)

# Extract required fields
TRANSCRIPT_PATH=$(echo "$INPUT" | jq -r '.transcript_path // empty')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
CWD=$(echo "$INPUT" | jq -r '.cwd // empty')

# Validate required inputs
if [[ -z "$TRANSCRIPT_PATH" ]] || [[ -z "$SESSION_ID" ]]; then
    exit 0  # Silently exit if required data is missing
fi

# Check if transcript file exists
if [[ ! -f "$TRANSCRIPT_PATH" ]]; then
    exit 0
fi

# Setup output directory
TRANSCRIPT_DIR="$CWD/.claude/transcripts"
mkdir -p "$TRANSCRIPT_DIR"

# Generate content hash of current transcript to detect changes
CURRENT_HASH=$(md5 -q "$TRANSCRIPT_PATH" 2>/dev/null || md5sum "$TRANSCRIPT_PATH" 2>/dev/null | cut -d' ' -f1 || echo "unknown")

# File paths
MAIN_TRANSCRIPT="$TRANSCRIPT_DIR/${SESSION_ID}.md"
HASH_FILE="$TRANSCRIPT_DIR/.${SESSION_ID}.hash"
FORK_COUNTER_FILE="$TRANSCRIPT_DIR/.${SESSION_ID}.fork_count"

# Initialize fork counter if it doesn't exist
if [[ ! -f "$FORK_COUNTER_FILE" ]]; then
    echo "0" > "$FORK_COUNTER_FILE"
fi

# Check if this is a fork (content hash changed but file exists)
PREVIOUS_HASH=""
if [[ -f "$HASH_FILE" ]]; then
    PREVIOUS_HASH=$(cat "$HASH_FILE")
fi

IS_FORK=false
if [[ -f "$MAIN_TRANSCRIPT" ]] && [[ -n "$PREVIOUS_HASH" ]] && [[ "$CURRENT_HASH" != "$PREVIOUS_HASH" ]]; then
    # Check if the transcript actually got shorter or diverged (indicating a fork)
    PREVIOUS_LINE_COUNT=$(wc -l < "$MAIN_TRANSCRIPT" 2>/dev/null || echo "0")
    CURRENT_LINE_COUNT=$(wc -l < "$TRANSCRIPT_PATH" 2>/dev/null || echo "0")

    # Read both files to compare content
    if [[ -f "$MAIN_TRANSCRIPT" ]]; then
        # Simple heuristic: if transcript changed but didn't just grow, it's likely a fork
        # This catches edits, regenerations, and branch switches
        LAST_TRANSCRIPT_HASH=$(tail -c 1000 "$MAIN_TRANSCRIPT" | md5 -q 2>/dev/null || tail -c 1000 "$MAIN_TRANSCRIPT" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "unknown")
        CURRENT_TAIL_HASH=$(tail -c 1000 "$TRANSCRIPT_PATH" | md5 -q 2>/dev/null || tail -c 1000 "$TRANSCRIPT_PATH" | md5sum 2>/dev/null | cut -d' ' -f1 || echo "unknown")

        if [[ "$LAST_TRANSCRIPT_HASH" != "$CURRENT_TAIL_HASH" ]]; then
            IS_FORK=true
        fi
    fi
fi

# If this is a fork, save the previous version
if [[ "$IS_FORK" == "true" ]] && [[ -f "$MAIN_TRANSCRIPT" ]]; then
    FORK_COUNT=$(cat "$FORK_COUNTER_FILE")
    FORK_COUNT=$((FORK_COUNT + 1))
    echo "$FORK_COUNT" > "$FORK_COUNTER_FILE"

    FORK_FILE="$TRANSCRIPT_DIR/${SESSION_ID}-fork-${FORK_COUNT}.md"
    cp "$MAIN_TRANSCRIPT" "$FORK_FILE"
fi

# Generate the markdown transcript
generate_markdown() {
    local transcript_file="$1"

    echo "# Claude Code Session Transcript"
    echo ""
    echo "**Session ID**: \`$SESSION_ID\`"
    echo "**Generated**: $(date '+%Y-%m-%d %H:%M:%S')"
    echo "**Working Directory**: \`$CWD\`"
    echo ""
    echo "---"
    echo ""

    # Parse JSONL and format as markdown
    local message_num=0
    while IFS= read -r line; do
        if [[ -z "$line" ]]; then
            continue
        fi

        local role=$(echo "$line" | jq -r '.role // empty')
        local content=$(echo "$line" | jq -r '.content // empty')
        local type=$(echo "$line" | jq -r '.type // empty')

        if [[ "$role" == "user" ]]; then
            message_num=$((message_num + 1))
            echo "## Message $message_num: User"
            echo ""
            if [[ "$type" == "text" ]]; then
                echo "$content"
            else
                echo "$line" | jq -r '.content // empty'
            fi
            echo ""
        elif [[ "$role" == "assistant" ]]; then
            echo "## Message $message_num: Assistant"
            echo ""

            # Parse assistant content (can be array of text and tool_use blocks)
            if echo "$line" | jq -e '.content | type == "array"' > /dev/null 2>&1; then
                echo "$line" | jq -c '.content[]' | while IFS= read -r block; do
                    local block_type=$(echo "$block" | jq -r '.type // empty')

                    if [[ "$block_type" == "text" ]]; then
                        echo "$block" | jq -r '.text // empty'
                        echo ""
                    elif [[ "$block_type" == "tool_use" ]]; then
                        local tool_name=$(echo "$block" | jq -r '.name // empty')
                        local tool_input=$(echo "$block" | jq -r '.input // empty')
                        local tool_id=$(echo "$block" | jq -r '.id // empty')

                        echo "### Tool Call: \`$tool_name\`"
                        echo ""
                        echo "**Tool ID**: \`$tool_id\`"
                        echo ""
                        echo "**Input**:"
                        echo '```json'
                        echo "$block" | jq '.input'
                        echo '```'
                        echo ""
                    fi
                done
            else
                echo "$content"
                echo ""
            fi
        elif [[ "$role" == "tool" ]] || [[ "$type" == "tool_result" ]]; then
            local tool_id=$(echo "$line" | jq -r '.tool_use_id // empty')
            local result_content=$(echo "$line" | jq -r '.content // empty')
            local is_error=$(echo "$line" | jq -r '.is_error // false')

            echo "### Tool Result"
            echo ""
            if [[ "$tool_id" != "empty" ]]; then
                echo "**Tool ID**: \`$tool_id\`"
            fi
            if [[ "$is_error" == "true" ]]; then
                echo "**Status**: ❌ Error"
            else
                echo "**Status**: ✅ Success"
            fi
            echo ""

            # Try to format result nicely
            if echo "$result_content" | jq . > /dev/null 2>&1; then
                echo "**Output**:"
                echo '```json'
                echo "$result_content" | jq .
                echo '```'
            else
                echo "**Output**:"
                echo '```'
                echo "$result_content"
                echo '```'
            fi
            echo ""
        fi
    done < "$transcript_file"
}

# Generate and save the transcript
generate_markdown "$TRANSCRIPT_PATH" > "$MAIN_TRANSCRIPT"

# Save the current hash
echo "$CURRENT_HASH" > "$HASH_FILE"

# Exit successfully (silently)
exit 0
