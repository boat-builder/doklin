#!/bin/sh
# After a Bash command that opened a pull request (`gh pr create`), tell the
# agent what the `mandatory` label does and that only the user decides it.
# Every other command passes through with nothing said. The release reads
# the label when the PR is merged, so adding it after the PR exists is in time.

jq -r '.tool_input.command // empty' | grep -q 'gh pr create' || exit 0

jq -n --arg context "This repository cuts a release from every merge to main. A PR labelled \`mandatory\` makes its release turn away every older Mac app and \`doklin\`: a Mac as soon as the release is out, \`doklin\` and the iPhone once a domain runs the release's worker. Add the label (\`gh pr edit <number> --add-label mandatory\`) only when the user asks for it. If this change leaves older apps or \`doklin\` unable to work with the new worker, ask the user whether its release should be mandatory." \
  '{hookSpecificOutput: {hookEventName: "PostToolUse", additionalContext: $context}}'
