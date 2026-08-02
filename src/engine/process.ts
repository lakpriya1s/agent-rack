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
  private buffer = new EventRingBuffer(512);
  private timeoutTimer?: NodeJS.Timeout;
  private killTimer?: NodeJS.Timeout;
  private cancellationTreePid?: number;

  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly adapter: AgentAdapter
  ) {}

  getBuffer(): EventRingBuffer {
    return this.buffer;
  }

  private finishCancellationTree(): void {
    if (this.cancellationTreePid === undefined) return;
    if (this.killTimer) clearTimeout(this.killTimer);
    signalProcessTree(this.cancellationTreePid, 'SIGKILL');
    this.cancellationTreePid = undefined;
  }

  async runSync(options: ProcessRunOptions): Promise<FormattedResult> {
    const cliArgs = this.adapter.getCLIArgs(options.prompt, options.mode);
    const env = sanitizeEnvironment(this.agentConfig.env, options.sanitizeEnv !== false);
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

          this.ptyProcess.onData((data: string) => {
            const events = this.adapter.parseChunk(data);
            this.buffer.pushMany(events);
          });

          this.ptyProcess.onExit(({ exitCode }) => {
            if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
            this.finishCancellationTree();
            if (this.killTimer) clearTimeout(this.killTimer);
            this.ptyProcess = undefined;
            const result = this.adapter.formatResponse(this.buffer.getAll(), exitCode);
            if (timeoutError) reject(timeoutError);
            else resolve(result);
          });
        } catch (err) {
          if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
          reject(err);
        }
      } else {
        // Standard execa stdio process
        try {
          const subprocess = execa(this.agentConfig.command, cliArgs, {
            cwd: options.workspace,
            env,
            reject: false,
            stdin: 'ignore',
            // A detached POSIX child is its own process-group leader, allowing cancellation
            // to signal every descendant rather than only the agent CLI wrapper.
            detached: process.platform !== 'win32',
          });
          this.execaSubprocess = subprocess;

          subprocess.stdout?.on('data', (chunk: Buffer) => {
            const events = this.adapter.parseChunk(chunk.toString('utf-8'));
            this.buffer.pushMany(events);
          });

          subprocess.stderr?.on('data', (chunk: Buffer) => {
            const events = this.adapter.parseChunk(chunk.toString('utf-8'));
            this.buffer.pushMany(events);
          });

          subprocess
            .then((result) => {
              if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
              this.finishCancellationTree();
            if (this.killTimer) clearTimeout(this.killTimer);
              this.execaSubprocess = undefined;
              const exitCode = result.exitCode ?? 0;
              const formattedResult = this.adapter.formatResponse(this.buffer.getAll(), exitCode);
              if (timeoutError) reject(timeoutError);
              else resolve(formattedResult);
            })
            .catch((err) => {
              if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
              this.finishCancellationTree();
            if (this.killTimer) clearTimeout(this.killTimer);
              this.execaSubprocess = undefined;
              reject(timeoutError ?? err);
            });
        } catch (err) {
          if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
          reject(err);
        }
      }
    });
  }

  sendInput(text: string): void {
    if (this.ptyProcess) {
      this.ptyProcess.write(text + '\n');
    } else if (this.execaSubprocess?.stdin) {
      this.execaSubprocess.stdin.write(text + '\n');
    } else {
      throw new Error('Process is not running or stdin is unavailable.');
    }
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
