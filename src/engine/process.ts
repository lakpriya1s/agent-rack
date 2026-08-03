import { execa, ResultPromise } from 'execa';
import { execFile } from 'node:child_process';
import pty from 'node-pty';
import { AgentAdapter, FormattedResult } from '../adapters/index.js';
import { EventRingBuffer } from './buffer.js';
import { AgentConfig } from '../config/schema.js';
import { sanitizeEnvironment } from '../security/env.js';

export interface ProcessRunOptions {
  prompt: string;
  workspace: string;
  mode?: string;
  timeoutSeconds?: number;
  sanitizeEnv?: boolean;
}

export interface AgentProcessControllerOptions {
  maxEvents?: number;
  maxBytes?: number;
}

/**
 * Signals the process group on POSIX so an agent cannot leave spawned descendants behind.
 * Windows has no process groups, so taskkill's /T option is the equivalent tree operation.
 */
function signalProcessTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    const args = ['/PID', String(pid), '/T'];
    if (signal === 'SIGKILL') args.push('/F');
    execFile('taskkill', args, () => undefined);
    return;
  }

  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // The process may already have exited.
    }
  }
}

export class AgentProcessController {
  private execaSubprocess?: ResultPromise;
  private ptyProcess?: pty.IPty;
  private buffer: EventRingBuffer;
  private timeoutTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private cancellationTreePid?: number;
  /**
   * True from spawn until the child has actually exited — which is *not* the same as the
   * session's user-facing status. Cancellation flips a session to 'cancelling' immediately
   * but the child lives on for up to the SIGKILL grace period, and the concurrency limit has
   * to count those still-live children or it can be overshot during that window.
   */
  private processLive = false;

  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly adapter: AgentAdapter,
    options: AgentProcessControllerOptions = {}
  ) {
    this.buffer = new EventRingBuffer({
      maxEvents: options.maxEvents,
      maxBytes: options.maxBytes,
    });
  }

  getBuffer(): EventRingBuffer {
    return this.buffer;
  }

  /** Whether a child process is still alive, regardless of the session's reported status. */
  isProcessLive(): boolean {
    return this.processLive;
  }

  private finishCancellationTree(): void {
    if (this.cancellationTreePid === undefined) return;
    if (this.killTimer) clearTimeout(this.killTimer);
    signalProcessTree(this.cancellationTreePid, 'SIGKILL');
    this.cancellationTreePid = undefined;
  }

  /**
   * Drains the adapter's line buffer, then formats. A CLI that exits without a trailing
   * newline leaves its final line held back in the adapter — for `claude --output-format json`
   * that final line is the entire response, so skipping this loses the whole result.
   */
  private finalizeResult(exitCode: number): FormattedResult {
    this.buffer.pushMany(this.adapter.flush());
    return this.adapter.formatResponse(this.buffer.getAll(), exitCode);
  }

  async runSync(options: ProcessRunOptions): Promise<FormattedResult> {
    const cliArgs = this.adapter.getCLIArgs(options.prompt, options.mode);
    const env = sanitizeEnvironment({
      customEnv: this.agentConfig.env,
      sanitize: options.sanitizeEnv !== false,
      inheritEnv: this.agentConfig.inheritEnv,
    });
    const timeoutMs = (options.timeoutSeconds || 600) * 1000;

    return new Promise<FormattedResult>((resolve, reject) => {
      let timeoutError: Error | undefined;
      // A timeout starts cancellation, but the run settles only after the child exits so
      // SessionManager.shutdown cannot return while escalation is still in progress.
      this.timeoutTimer = setTimeout(() => {
        timeoutError = new Error(
          `Agent execution timed out after ${options.timeoutSeconds || 600} seconds.`
        );
        this.cancel();
      }, timeoutMs);

      if (this.agentConfig.transport === 'pty_interactive') {
        try {
          this.ptyProcess = pty.spawn(this.agentConfig.command, cliArgs, {
            name: 'xterm-256color',
            cols: 80,
            rows: 30,
            cwd: options.workspace,
            env,
          });
          this.processLive = true;

          this.ptyProcess.onData((data: string) => {
            const events = this.adapter.parseChunk(data);
            this.buffer.pushMany(events);
          });

          this.ptyProcess.onExit(({ exitCode }) => {
            if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
            this.finishCancellationTree();
            if (this.killTimer) clearTimeout(this.killTimer);
            this.ptyProcess = undefined;
            this.processLive = false;
            const result = this.finalizeResult(exitCode);
            if (timeoutError) reject(timeoutError);
            else resolve(result);
          });
        } catch (err) {
          if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
          this.processLive = false;
          reject(err);
        }
      } else {
        // Standard execa stdio process
        try {
          const subprocess = execa(this.agentConfig.command, cliArgs, {
            cwd: options.workspace,
            env,
            reject: false,
            // These transports take the prompt as argv and have no second turn, so an open
            // stdin would only risk the CLI blocking on a read that never completes.
            // `agent_session_send` refuses them up front via adapter capabilities.
            stdin: 'ignore',
            // A detached POSIX child is its own process-group leader, allowing cancellation
            // to signal every descendant rather than only the agent CLI wrapper.
            detached: process.platform !== 'win32',
          });
          this.execaSubprocess = subprocess;
          this.processLive = true;

          subprocess.stdout?.on('data', (chunk: Buffer) => {
            const events = this.adapter.parseChunk(chunk.toString('utf-8'));
            this.buffer.pushMany(events);
          });

          // stderr carries diagnostics, not protocol frames, so it must not be fed through
          // the JSON parser — a warning line would otherwise surface as agent 'text' output
          // and could end up inside a review's parsed result.
          subprocess.stderr?.on('data', (chunk: Buffer) => {
            const text = chunk.toString('utf-8').trim();
            if (!text) return;
            this.buffer.push({
              type: 'status',
              content: text,
              metadata: { stream: 'stderr' },
              timestamp: Date.now(),
            });
          });

          subprocess
            .then((result) => {
              if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
              this.finishCancellationTree();
              if (this.killTimer) clearTimeout(this.killTimer);
              this.execaSubprocess = undefined;
              this.processLive = false;
              const exitCode = result.exitCode ?? 0;
              const formattedResult = this.finalizeResult(exitCode);
              if (timeoutError) reject(timeoutError);
              else resolve(formattedResult);
            })
            .catch((err) => {
              if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
              this.finishCancellationTree();
              if (this.killTimer) clearTimeout(this.killTimer);
              this.execaSubprocess = undefined;
              this.processLive = false;
              reject(timeoutError ?? err);
            });
        } catch (err) {
          if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
          this.processLive = false;
          reject(err);
        }
      }
    });
  }

  sendInput(text: string): void {
    if (!this.adapter.capabilities.supportsFollowUp) {
      throw new Error(
        `Transport '${this.agentConfig.transport}' cannot accept follow-up input: it takes its ` +
          `prompt as a command-line argument and exits when the turn ends, so there is no open ` +
          `input channel. Start a new session with the follow-up as its prompt instead.`
      );
    }

    if (this.ptyProcess) {
      this.ptyProcess.write(text + '\n');
      return;
    }
    if (this.execaSubprocess?.stdin) {
      this.execaSubprocess.stdin.write(text + '\n');
      return;
    }
    throw new Error('Process is not running or its input channel is unavailable.');
  }

  cancel(): void {
    if (this.timeoutTimer) clearTimeout(this.timeoutTimer);

    if (this.ptyProcess) {
      const ptyProcess = this.ptyProcess;
      this.cancellationTreePid ??= ptyProcess.pid;
      signalProcessTree(ptyProcess.pid, 'SIGINT');
      this.killTimer ??= setTimeout(() => {
        signalProcessTree(ptyProcess.pid, 'SIGKILL');
      }, 3000);
    }

    if (this.execaSubprocess) {
      const subprocess = this.execaSubprocess;
      if (subprocess.pid !== undefined) {
        this.cancellationTreePid ??= subprocess.pid;
        signalProcessTree(subprocess.pid, 'SIGINT');
        this.killTimer ??= setTimeout(() => {
          signalProcessTree(subprocess.pid!, 'SIGKILL');
        }, 3000);
      }
    }
  }
}
