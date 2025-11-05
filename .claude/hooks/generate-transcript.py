#!/usr/bin/env python3
"""
Claude Code transcript generation hook.
Generates markdown transcripts from JSONL conversation logs.
"""

import json
import sys
from pathlib import Path
from datetime import datetime
from tempfile import NamedTemporaryFile
from typing import Optional, Tuple, List, Dict, Any


def read_jsonl_reverse(file_path: Path) -> List[Dict[str, Any]]:
    """Read JSONL file and return lines in reverse order."""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            lines = f.readlines()

        # Parse and return in reverse order
        result = []
        for line in reversed(lines):
            line = line.strip()
            if line:
                try:
                    result.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return result
    except Exception:
        return []


def find_target_user_prompt(
    transcript_path: Path,
    hook_event: str
) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
    """
    Find the target user prompt to collect responses after.

    For SessionEnd: get the last (most recent) user prompt
    For UserPromptSubmit: get the second-to-last user prompt

    Returns: (prompt_text, full_json_line)
    """
    entries = read_jsonl_reverse(transcript_path)

    target_count = 1 if hook_event == "SessionEnd" else 2
    user_count = 0

    for entry in entries:
        if entry.get('type') == 'user':
            user_count += 1
            if user_count == target_count:
                # Extract message content
                content = entry.get('message', {}).get('content')

                # Handle both string and array formats
                if isinstance(content, list) and len(content) > 0:
                    prompt_text = content[0].get('text', '')
                elif isinstance(content, str):
                    prompt_text = content
                else:
                    prompt_text = ''

                # Skip if null or empty
                if prompt_text and prompt_text != 'null':
                    return prompt_text, entry

                # Reset counter to keep looking for valid prompt
                user_count = target_count - 1

    return None, None


def format_tool_use(block: Dict[str, Any], transcript_path: Path) -> str:
    """Format a tool use block as collapsible details."""
    tool_name = block.get('name', '')
    tool_use_id = block.get('id', '')
    tool_input = block.get('input', {})

    output = f"""<details>
<summary>🔧 <strong>{tool_name}</strong></summary>

**Input:**
```json
{json.dumps(tool_input, indent=2)}
```
"""

    # Find matching tool result
    tool_output = None
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                if tool_use_id in line:
                    try:
                        result_entry = json.loads(line.strip())
                        if result_entry.get('type') == 'tool_result':
                            content = result_entry.get('message', {}).get('content', [])
                            if content and len(content) > 0:
                                tool_output = content[0].get('content', '')
                                break
                    except json.JSONDecodeError:
                        continue
    except Exception:
        pass

    if tool_output:
        output += f"""
**Output:**
```
{tool_output}
```
"""

    output += """</details>
<br>

"""
    return output


def collect_assistant_responses(
    transcript_path: Path,
    target_user_line: Optional[Dict[str, Any]]
) -> Tuple[str, bool]:
    """
    Collect assistant responses after the target user prompt.

    Returns: (formatted_responses, was_interrupted)
    """
    if not target_user_line:
        return '', False

    responses = []
    was_interrupted = False
    should_collect = False

    # Read forward through transcript
    try:
        with open(transcript_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue

                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue

                entry_type = entry.get('type')

                # Check if this is the target user prompt line
                if not should_collect:
                    if entry == target_user_line:
                        should_collect = True
                    continue

                # Collect assistant messages
                if entry_type == 'assistant':
                    # Check if interrupted
                    stop_reason = entry.get('message', {}).get('stop_reason')
                    if stop_reason is None or stop_reason == '':
                        was_interrupted = True

                    # Process content blocks
                    content = entry.get('message', {}).get('content', [])
                    if isinstance(content, list):
                        for block in content:
                            block_type = block.get('type')

                            if block_type == 'text':
                                text = block.get('text', '')
                                if text:
                                    responses.append(f"**Assistant:** {text}\n\n")

                            elif block_type == 'tool_use':
                                responses.append(format_tool_use(block, transcript_path))

    except Exception:
        pass

    return ''.join(responses), was_interrupted


def create_header(session_id: str, cwd: str) -> str:
    """Create the markdown header for a new session."""
    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    return f"""# Claude Code Session

**Session ID**: `{session_id}`<br>
**Started**: {timestamp}<br>
**Working Directory**: `{cwd}`<br>

---

"""


def assemble_transcript(
    main_transcript: Path,
    hook_event: str,
    user_prompt: Optional[str],
    assistant_responses: str,
    was_interrupted: bool,
    previous_user_prompt: Optional[str]
) -> str:
    """Assemble the final transcript content."""

    # Read existing transcript
    if main_transcript.exists():
        with open(main_transcript, 'r', encoding='utf-8') as f:
            lines = f.readlines()
    else:
        lines = []

    # Extract header (first 8 lines)
    header = ''.join(lines[:8]) if len(lines) >= 8 else ''

    # Extract existing content (after header)
    existing_content = ''.join(lines[8:]) if len(lines) > 8 else ''

    # Build new content
    new_content = []

    # Add current user prompt (only for UserPromptSubmit)
    if hook_event == 'UserPromptSubmit' and user_prompt:
        timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        new_content.append(f'**User ({timestamp}):** <span style="color: green;">{user_prompt}</span><br>\n\n')

    # Handle content assembly based on event type
    if hook_event == 'UserPromptSubmit':
        # Add separator and previous exchange
        if existing_content:
            new_content.append('---\n\n')

            if previous_user_prompt:
                new_content.append(f'**User:** <span style="color: green;">{previous_user_prompt}</span><br>\n\n')

            if assistant_responses:
                new_content.append(assistant_responses)

                # Add status indicator
                if hook_event == 'SessionEnd':
                    timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                    new_content.append(f'<span style="color: blue;">**[Session Ended: {timestamp}]**</span>\n\n')
                elif was_interrupted:
                    new_content.append('<span style="color: red;">**[Interrupted]**</span>\n\n')

            # Add rest of existing content (skip first 2 lines - old prompt + blank)
            old_lines = existing_content.split('\n')
            if len(old_lines) > 2:
                new_content.append('\n'.join(old_lines[2:]))

    else:  # SessionEnd
        # Insert assistant responses after first user prompt in existing content
        if existing_content and assistant_responses:
            lines = existing_content.split('\n')
            first_user_line = None

            for i, line in enumerate(lines):
                if line.startswith('**User'):
                    first_user_line = i
                    break

            if first_user_line is not None:
                # Split content at first user prompt
                new_content.extend(lines[:first_user_line + 2])  # Include user line + blank line
                new_content.append(assistant_responses)

                # Add session ended indicator
                timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                new_content.append(f'<span style="color: blue;">**[Session Ended: {timestamp}]**</span>\n\n')

                # Add rest of content
                new_content.extend(lines[first_user_line + 2:])
            else:
                # No user prompt found, just append
                new_content.append(existing_content)
                new_content.append(assistant_responses)
                timestamp = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
                new_content.append(f'<span style="color: blue;">**[Session Ended: {timestamp}]**</span>\n\n')
        else:
            new_content.append(existing_content)

    return header + ''.join(new_content)


def main():
    """Main entry point for the transcript generator."""
    try:
        # Read input from stdin
        input_data = json.loads(sys.stdin.read())

        # Extract required fields
        transcript_path = Path(input_data.get('transcript_path', ''))
        session_id = input_data.get('session_id', '')
        cwd = input_data.get('cwd', '')
        hook_event = input_data.get('hook_event_name', '')
        user_prompt = input_data.get('prompt', '')

        # Validate required inputs
        if not transcript_path or not session_id:
            sys.exit(0)

        if not transcript_path.exists():
            sys.exit(0)

        # Only process UserPromptSubmit and SessionEnd events
        if hook_event not in ['UserPromptSubmit', 'SessionEnd']:
            sys.exit(0)

        # Setup paths
        transcript_dir = Path(cwd) / '.claude' / 'transcripts'
        transcript_dir.mkdir(parents=True, exist_ok=True)
        main_transcript = transcript_dir / f'{session_id}.md'

        # Create header if new session
        if not main_transcript.exists():
            with open(main_transcript, 'w', encoding='utf-8') as f:
                f.write(create_header(session_id, cwd))

        # Find target user prompt
        previous_user_prompt, target_user_line = find_target_user_prompt(
            transcript_path,
            hook_event
        )

        # Collect assistant responses
        assistant_responses, was_interrupted = collect_assistant_responses(
            transcript_path,
            target_user_line
        )

        # Assemble and write transcript
        # Only proceed if we have new content or it's a SessionEnd event
        if user_prompt or hook_event == 'SessionEnd':
            final_content = assemble_transcript(
                main_transcript,
                hook_event,
                user_prompt,
                assistant_responses,
                was_interrupted,
                previous_user_prompt
            )

            # Write atomically using temp file
            with NamedTemporaryFile(
                mode='w',
                encoding='utf-8',
                dir=transcript_dir,
                delete=False,
                suffix='.tmp'
            ) as tmp:
                tmp.write(final_content)
                tmp_path = Path(tmp.name)

            # Atomic rename
            tmp_path.replace(main_transcript)

    except Exception:
        # Fail silently
        sys.exit(0)


if __name__ == '__main__':
    main()
