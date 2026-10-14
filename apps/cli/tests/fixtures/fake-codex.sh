#!/usr/bin/env bash
# A stand-in for `codex exec --json`: the events of a turn, in the shape the CLI prints (thread.started,
# turn.started, item.*, turn.completed). It records how it was called, in the folder it runs in.
printf '%s|%s|token=%s\n' "$CODEX_HOME" "$*" "${AGENTS_MULTI_MCP_TOKEN:-}" >> "$PWD/calls.txt"
prompt="${*: -1}"
if [[ "$2" == resume ]]; then thread="$(printf '%s\n' "$@" | grep -m1 -E '^[0-9a-f]{8}-')"; verb="resumed"; else thread="0192aaaa-bbbb-cccc-dddd-000000000001"; verb="did"; fi
echo '{"type":"thread.started","thread_id":"'"$thread"'"}'
echo '{"type":"turn.started"}'
echo '{"type":"error","message":"Reconnecting... 1/5 (a hiccup)"}'
echo '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls","status":"in_progress"}}'
echo '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"'"$verb"': '"$prompt"'"}}'
if [[ "$prompt" == fail* ]]; then echo '{"type":"turn.failed","error":{"message":"no luck"}}'; exit 1; fi
echo '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'
