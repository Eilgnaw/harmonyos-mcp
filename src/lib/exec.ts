import { spawn, ChildProcess, SpawnOptions } from "node:child_process";

export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
};

export type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
};

export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const spawnOpts: SpawnOptions = {
      cwd: opts.cwd,
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    };
    const proc = spawn(cmd, args, spawnOpts);
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    proc.stdout?.on("data", (c) => { stdout += c.toString(); });
    proc.stderr?.on("data", (c) => { stderr += c.toString(); });

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          proc.kill("SIGKILL");
        }, opts.timeoutMs)
      : null;

    proc.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        durationMs: Date.now() - t0,
        timedOut,
      });
    });
    proc.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });

    if (opts.input !== undefined) {
      proc.stdin?.write(opts.input);
      proc.stdin?.end();
    }
  });
}

export type BackgroundProc = {
  proc: ChildProcess;
  stdoutBuffer: string[];
  stderrBuffer: string[];
  startedAt: number;
};

export function spawnBackground(cmd: string, args: string[], opts: RunOptions = {}): BackgroundProc {
  const proc = spawn(cmd, args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutBuffer: string[] = [];
  const stderrBuffer: string[] = [];
  proc.stdout?.on("data", (c) => stdoutBuffer.push(c.toString()));
  proc.stderr?.on("data", (c) => stderrBuffer.push(c.toString()));
  return { proc, stdoutBuffer, stderrBuffer, startedAt: Date.now() };
}
