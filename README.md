# ureport-agent

Runs UReport jobs on your own machine: Auto-Heal fixes (checkout, AI fix, pull request) and test reruns.
Full documentation is in the UReport docs under **ureport-agent**.

## Quick start

1. Copy `ureport-agent.yml.example` to `ureport-agent.yml`.
2. Set `ureport_url` and `agent_token` (generate the token on the **My Agent** page in UReport).
3. Install dependencies if you have not: `npm ci --omit=dev`
4. Run it: `node agent.js`

Requirements: Node.js 18 or newer, `git`, and the AI CLI your playbooks use (`claude` or `gemini`), already logged in.

## Credentials for a playbook (`env_file`)

When a test needs a login, API key or token, do not put it in the playbook. Split it in two:

1. **In UReport**, on the playbook, list the variable **names** under *Required environment variables*
   (for example `STAGE_USER`, `STAGE_PASSWORD`). Only the names are saved.
2. **On this machine**, provide the **values**, either by exporting them in the shell that starts the agent,
   or by putting them in `ureport-agent.env`, the empty file that ships next to `ureport-agent.yml.example`:

```bash
# ureport-agent.env: one KEY=VALUE per line, # for comments
STAGE_USER=qa-bot
STAGE_PASSWORD="a password with spaces"
```

`ureport-agent.yml.example` already has `env_file: ./ureport-agent.env` turned on. If you removed that line, add it back.
Restart the agent after editing. A job only gets the variables its playbook lists, a variable already set in the shell wins over the file,
and a listed name with no value anywhere fails the job at once. Keep the file out of git and run `chmod 600 ureport-agent.env`.
Full rules and troubleshooting: UReport docs, **ureport-agent**, section *Credentials for playbooks*.

## Tests

`npm test`
