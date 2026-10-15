---
name: review-and-fix
description: Review a branch or PR in a project, then fix what the review found. Use when a change needs a second pair of eyes before it merges.
---

# review-and-fix

A saved workflow: a skill the coordinator reads, fills from the conversation and shows to the owner before
it starts anything (`workflow_load`, then `workflow_start`). The project's own `.agents/workflows/` wins
over this one on the same name.

Steps:

- **review** reads the change and writes down what is wrong.
- **fix** applies it, after the review.

Change the profile and model to the account you want to spend; fill `{{folder}}` and `{{target}}`.

## Plan

```json
{
  "name": "review-and-fix",
  "folder": "{{folder}}",
  "steps": [
    {
      "id": "review",
      "profile": "personal",
      "model": "opus",
      "prompt": "Review {{target}}: correctness first, then what is missing in tests. Change nothing; list findings, most serious first."
    },
    {
      "id": "fix",
      "profile": "personal",
      "after": ["review"],
      "prompt": "Fix the findings of the review in {{target}}. Run the project's checks before you finish."
    }
  ]
}
```
