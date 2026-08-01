import { execa, ResultPromise } from 'execa';
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

export class AgentProcessController {
  private execaSubprocess?: ResultPromise;
  private ptyProcess?: pty.IPty;
  private buffer = new EventRingBuffer(512);
  private timeoutTimer?: NodeJS.Timeout;

  constructor(
    public readonly agentConfig: AgentConfig,
    public readonly adapter: AgentAdapter
  ) {}

  getBuffer(): EventRingBuffer {
    return this.buffer;
  }

  async runSync(options: ProcessRunOptions): Promise<FormattedResult> {
    const cliArgs = this.adapter.getCLIArgs(options.prompt, options.mode);
    const env = sanitizeEnvironment(this.agentConfig.env, options.sanitizeEnv !== false);
    const timeoutMs = (options.timeoutSeconds || 600) * 1000;

    return new Promise<FormattedResult>((resolve, reject) => {
      // Handle timeout
      this.timeoutTimer = setTimeout(() => {
        this.cancel();
        reject(new Error(`Agent execution timed out after ${options.timeoutSeconds || 600} seconds.`));
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
            const result = this.adapter.formatResponse(this.buffer.getAll(), exitCode);
            resolve(result);
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
              const exitCode = result.exitCode ?? 0;
              const formattedResult = this.adapter.formatResponse(this.buffer.getAll(), exitCode);
              resolve(formattedResult);
            })
            .catch((err) => {
              if (this.timeoutTimer) clearTimeout(this.timeoutTimer);
              reject(err);
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
      try {
        this.ptyProcess.kill();
      } catch {
        // Ignore
      }
    }

    if (this.execaSubprocess) {
      try {
        this.execaSubprocess.kill('SIGINT');
        setTimeout(() => {
          if (this.execaSubprocess) {
            this.execaSubprocess.kill('SIGKILL');
          }
        }, 3000);
      } catch {
        // Ignore
      }
    }
  }
}
