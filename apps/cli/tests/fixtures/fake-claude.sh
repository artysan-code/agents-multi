#!/usr/bin/env bash
# A stand-in for `claude -p --input-format stream-json …` in the agents tests: it reads the task, asks
# for one permission, and ends the turn with what it was told. Then it waits for more, until EOF.
read -r _
echo '{"type":"system","subtype":"init","session_id":"s-1"}'
echo '{"type":"assistant","message":{"content":[{"type":"text","text":"on it"}]}}'
echo '{"type":"control_request","request_id":"r-1","request":{"subtype":"can_use_tool","tool_name":"Bash","input":{"command":"git push"}}}'
read -r reply
if grep -q '"allow"' <<<"$reply"; then out=allowed; else out=denied; fi
echo "{\"type\":\"result\",\"subtype\":\"success\",\"result\":\"$out\",\"total_cost_usd\":0.01}"
while read -r _; do
  echo '{"type":"assistant","message":{"content":[{"type":"text","text":"heard you"}]}}'
  echo '{"type":"result","subtype":"success","result":"again"}'
done
