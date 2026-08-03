# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately via GitHub's
[security advisory form](https://github.com/lakpriya1s/agent-rack/security/advisories/new)
rather than a public issue. Please include the version, your effective config (with secrets
removed), and the steps to reproduce.

## What agent-rack is

agent-rack spawns local AI coding agent CLIs as subprocesses and exposes them as MCP tools.
Those subprocesses run **as your user**, and depending on the configured execution policy they
can read and write files and run shell commands. agent-rack is a way to *drive* those agents; it
is not a substitute for the sandboxing the underlying CLI provides (or fails to provide).

## Threat model

### What agent-rack defends against

| Threat | Mitigation |
| --- | --- |
| A client pointing an agent at a directory outside the configured workspaces | `validateWorkspacePath` resolves symlinks/realpaths and validates before every spawn; the child's cwd is the validated canonical path |
| A client escalating its own authority per call | `resolveExecutionMode` rejects a `mode` exceeding `security.executionPolicy` |
| A configured escape-hatch flag silently nullifying the policy | `applyExecutionPolicy` strips `ESCAPE_HATCH_ARGS` under every policy but `danger-full-access` |
| A "review" that can actually write | `agent_review` always resolves at policy `read-only`; `agent_session_create` cannot create review sessions |
| Credentials leaking into sub-agent environments | Per-agent `inheritEnv` allowlist; broad pattern denylist otherwise; redaction in human-facing output |
| A web page driving the local SSE server (incl. DNS rebinding) | Bearer token, `Origin` rejection, loopback-`Host` requirement |
| Another local process driving the SSE server without credentials | Bearer token, published mode `0600` |
| Command injection through a review's `baseRef` | Ref pattern validation, then resolution to a commit SHA; only the SHA reaches the prompt |
| Orphaned agent processes after cancel/shutdown | Process-group signalling with SIGINT→SIGKILL escalation; `taskkill /T` on Windows |
| Unbounded memory growth on a long-lived server | Session retention/pruning; per-session event **and** byte caps on retained logs |

### What agent-rack does *not* defend against

These are real limitations, stated plainly rather than papered over:

- **`allowedWorkspaces` is not a filesystem sandbox.** It constrains the directory an agent is
  launched in, not what the process can subsequently reach. An agent that can run shell commands
  can read absolute paths elsewhere, reach the network, and execute other programs.
- **Most CLIs cannot enforce a policy.** Only `codex` ships a real OS-level sandbox
  (`--sandbox`). Claude Code's `--permission-mode` gates prompting, not filesystem access, and
  `agy`/`opencode` expose neither. For those, a policy short of `danger-full-access` is
  best-effort. `agent-rack agents` and `agent_list_available` report exactly which is which.
- **No same-user isolation.** Any process running as your user can read the SSE token file, your
  config, or attach to the process. Loopback + token protects against browser origins and
  unauthenticated local callers, not against your own account.
- **Prompt injection is not solved.** Content an agent reads (repository files, fetched pages,
  dependency READMEs) can attempt to redirect it. Under `workspace-write` or
  `danger-full-access`, a successfully injected instruction executes with the agent's authority.
  Use `read-only` for anything reviewing untrusted code.
- **`danger-full-access` means what it says.** It passes each CLI's own bypass flag. There is no
  residual protection at that level beyond the launch-directory check.

## Hardening recommendations

1. Keep `security.executionPolicy` at `read-only` or `workspace-write`. Reach for
   `danger-full-access` only for a specific task, and prefer a per-call `mode` narrowing instead.
2. Prefer `codex` when you need a policy that is genuinely enforced.
3. Declare `inheritEnv` per agent so no credential reaches a sub-agent unless you named it.
4. List `allowedWorkspaces` explicitly rather than relying on the cwd default. agent-rack warns
   on startup when no config file was found, precisely because the default is implicit.
5. Leave `security.requireSseAuth` at `true`. Use `stdio` transport when you do not need a shared
   server, since it has no network surface at all.
6. Review what you are asking for: a sub-agent given a prompt derived from untrusted input is an
   untrusted actor with your file permissions.

## Supported versions

agent-rack is pre-1.0. Security fixes land on the latest minor release; there are no backports to
earlier minors. Pin an exact version if you need reproducibility.
