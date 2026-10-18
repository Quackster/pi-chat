# AGENTS.md

This file is written for a capable developer who has never seen this code.
You must be able to read, fix, and extend it without asking anyone.

## Engineering principles

- Clarity beats cleverness.
- Explicit beats implicit.
- Minimize magic.
- If a trick needs an explanation, write the plain version instead.
- Keep functions small.
- Keep modules cohesive.
- No hidden globals.
- State flows through explicitly constructed and owned objects (Engine, Model, Backend).
- There is no process-wide singleton. Keep it that way.
- Write every component with concurrent use in mind.
- Pi is not the only supported harness.
- Each harness plugs into a shared harness system.
- Adding a new harness must not require changes to other harnesses.

## Naming (Google style)

- Types (class, struct, enum, alias, concept): PascalCase
- Functions and methods: camelCase
- Variables, parameters, members: snake_case
- Private members get a trailing underscore (buffer_)
- Namespaces: snake_case
- Files: snake_case.hpp / snake_case.cpp
- Test files: snake_test.cpp
- Macros: SCREAMING_SNAKE_CASE
- Avoid macros altogether where possible

## Hard rules

These rules are set by the project owner.

### One canonical implementation

- Every piece of logic has exactly one canonical implementation.
- Shared logic is extracted into a single free function owned by the appropriate module.
- Never copy-paste-adapt.

### No trivial pass-through methods

- Do not write a method whose body only calls one other method and returns its result.
- Call the target directly instead.
- A wrapper is allowed only when it adds a contract.
- Allowed contracts: synchronization, caching, a stable public API over changing internals, virtual dispatch.

### File size and structure

- One responsibility per file.
- One primary class or component per header/source pair.
- Every file stays under 600 lines. This is a hard limit.
- When a file approaches the limit, split responsibilities. Do not append.
- Keep only a few files per folder (roughly five or fewer).
- When a module outgrows that, split it into subfolders by concern.

### Modern C++20

- RAII.
- const-correctness.
- [[nodiscard]] on anything returning an error, a status, or a new object.
- std::span instead of raw pointer+length pairs.
- Include what you use.
- Forward declarations in headers.
- #pragma once.

### Error handling

- Exceptions are only for programmer errors and fatal startup failures.
- Runtime I/O, weight loading/parsing, and device errors use result-style returns (std::expected) or std::error_code.
- Follow the style of the module being touched.
- Exceptions never cross thread boundaries.

### Pluggable harnesses

- Pi is not the only supported harness.
- Each harness lives in its own module.
- Core code depends on the shared harness interface.
- Core code must not depend on a specific harness.
- A new harness plugs in behind the shared interface.
- Adding a harness must not require changes to other harnesses.
- Harness-specific behavior stays inside the harness module.
- Do not add harness-specific branches to shared code.

### Headless Pi processes

- Always launch Pi in headless mode.
- Use `-p` (print) or `--mode rpc` for programmatic runs.
- Do not launch interactive TUI sessions from tools, scripts, or harnesses.
- This applies to any harness, not only pi.

### No new tests

- Do not create new tests.
- Do not add test files, test functions, or test targets.

### No unsolicited docs files

- Do not create new files under docs/ (or new .md files anywhere) unless the user explicitly asks or an approved plan calls for them.

### Method documentation

- Document every method.
- Max 6 lines above every method.
- Do not document fields unless the comment helps later or the field holds magic numbers.

### No magic numbers

- Numbers are not repeated in code.
- Every repeated literal gets a named constant.
- Style: file-local constexpr with kCamelCase names (kDefaultBlockTokens).

### Actionable logs

- Every diagnostic line carries identifying context in a message prefix (e.g. "core: ...").

### Documentation style

- Write markdown in plain standard English in the style of ASD-STE100 Simplified Technical English.
- Short sentences.
- One idea per sentence.
- No idioms.
- No contractions.
- Do not use em dashes. Use a period, a comma, or a new sentence instead.

### Commit messages

- All commits must have a prefix.
- Example: feat(added x support): describe
- Example: fixed(bug here): describe bug
- A milestone commit must include source code changes.
- Do not make a commit of only markdown (.md) files, unless told to commit them explicitly.
