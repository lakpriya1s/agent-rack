/**
 * Ink's `useInput` requires raw-mode stdin support, which only real terminals provide. Piped
 * or redirected stdin (scripts, CI, SSH without a pty, some editor/task-runner terminals) makes
 * Ink throw an unhandled "Raw mode is not supported" exception instead of rendering anything.
 */
export function dashboardTTYError(stdin: { isTTY?: boolean }): string | null {
  if (stdin.isTTY) return null;

  return [
    'agent-rack dashboard requires an interactive terminal (TTY) on stdin.',
    "It looks like stdin isn't a real terminal — this happens when the command is piped,",
    'redirected, run from a script/CI, over SSH without a pty (`ssh -t`), or inside some',
    'editor/task-runner terminals.',
    'Run `agent-rack dashboard` (or `agent-rack ui`) directly in a normal interactive terminal.',
  ].join('\n');
}
