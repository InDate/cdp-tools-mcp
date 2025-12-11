# Notes about working with LLM's.

- LLM's are optimistic about their work. I expect to be ignored when not explicit.
- MCP tools are not directly accessible, so changes are made either by the optimistic LLM, sometimes incorrectly or we need a way to edit the config
- Always provide a backdoor into the config that will override LLM's. That way we can force the desired behavior when needed.