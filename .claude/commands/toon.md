# TOON (Token-Oriented Object Notation)

A lightweight data format designed to minimize token usage when passing structured data to LLMs.

## Syntax Reference

| Type | Syntax | Example |
|------|--------|---------|
| Key-value | `key:value;` | `name:Luna;age:3` |
| Spaces in values | `(...)` | `title:(Chief Snack Manager)` |
| Arrays (unordered) | `[item\|item]` | `pets:[cat\|dog\|ferret]` |
| Lists (ordered) | `<item\|item>` | `shopping:<milk\|eggs\|bread>` |
| Nested objects | `{...}` | `user:{name:Luna;stats:{speed:9;stealth:10}}` |

## Rules

1. Key-value pairs separated by semicolons
2. No quotes needed for simple strings
3. Use parentheses `()` for values containing spaces or special characters
4. Arrays `[]` for unordered collections, Lists `<>` for ordered sequences
5. Pipe `|` separates items in arrays/lists
6. Curly braces `{}` for nested structures

## Examples

**Simple object:**
```
name:Luna;age:3;color:silver
```

**With spaces:**
```
name:Luna;title:(Chief Snack Manager);active:true
```

**With array:**
```
name:Luna;pets:[cat|dog|ferret];active:true
```

**Nested:**
```
user:{name:Luna;stats:{speed:9;stealth:10}};timestamp:123456
```

## When to Use

- Data passed directly into LLM prompts
- Internal tool outputs within AI workflows
- RAG systems and metadata encoding
- Bulk classification tasks
- Scenarios prioritizing compactness over schema validation

## When NOT to Use

- Public APIs (use JSON)
- External systems requiring schema validation
- Anywhere standardized formats are required

## Token Efficiency

~58% reduction compared to JSON (26 tokens → 11 tokens for equivalent data).

---

Use TOON format when the user requests token-efficient data representation or when outputting structured data that will be consumed by LLMs.
