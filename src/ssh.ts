export interface SshExecOptions {
  host: string;
  user?: string;
  command: string;
  env?: Record<string, string>;
  timeoutMs?: number;
}

export interface SshExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function sshExec(opts: SshExecOptions): Promise<SshExecResult> {
  const user = opts.user ?? "agent";

  // Build env prefix: export KEY=val; export KEY2=val2;
  // Wrapped in bash -c so shell builtins (cd, &&) work with env vars
  let remoteCommand = opts.command;
  if (opts.env && Object.keys(opts.env).length > 0) {
    const exports = Object.entries(opts.env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
      .join("; ");
    remoteCommand = `bash -c ${shellEscape(`${exports}; ${remoteCommand}`)}`;
  }

  const args = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    "-o", "LogLevel=ERROR",
    `${user}@${opts.host}`,
    remoteCommand,
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  const exitCode = await proc.exited;

  if (timer) clearTimeout(timer);

  if (timedOut) {
    throw new Error(`SSH command timed out after ${opts.timeoutMs}ms`);
  }

  return { exitCode, stdout, stderr };
}

export async function waitForSsh(
  host: string,
  user = "agent",
  timeoutMs = 180_000
): Promise<void> {
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    attempt++;
    const elapsed = Math.round((Date.now() - start) / 1000);
    console.log(`SSH probe ${attempt} to ${host} (${elapsed}s elapsed)...`);

    const proc = Bun.spawn(
      [
        "ssh",
        "-o", "StrictHostKeyChecking=no",
        "-o", "UserKnownHostsFile=/dev/null",
        "-o", "ConnectTimeout=10",
        "-o", "BatchMode=yes",
        "-o", "LogLevel=ERROR",
        `${user}@${host}`,
        "echo ok",
      ],
      { stdout: "pipe", stderr: "pipe" }
    );

    const stdout = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;
    if (exitCode === 0) {
      console.log(`SSH ready on ${host}`);
      return;
    }

    // Log auth failures differently from connection failures
    if (stderr.includes("Permission denied")) {
      console.log(`SSH probe ${attempt}: auth failed (key mismatch?)`);
    }

    await new Promise((r) => setTimeout(r, 5_000));
  }
  throw new Error(`SSH on ${host} not reachable within ${timeoutMs / 1000}s`);
}

export interface SshExecStreamingOptions extends SshExecOptions {
  onChunk: (text: string, stream: "stdout" | "stderr") => void;
}

export async function sshExecStreaming(opts: SshExecStreamingOptions): Promise<SshExecResult> {
  const user = opts.user ?? "agent";

  let remoteCommand = opts.command;
  if (opts.env && Object.keys(opts.env).length > 0) {
    const exports = Object.entries(opts.env)
      .map(([k, v]) => `export ${k}=${shellEscape(v)}`)
      .join("; ");
    remoteCommand = `bash -c ${shellEscape(`${exports}; ${remoteCommand}`)}`;
  }

  const args = [
    "ssh",
    "-o", "StrictHostKeyChecking=no",
    "-o", "UserKnownHostsFile=/dev/null",
    "-o", "ConnectTimeout=10",
    "-o", "BatchMode=yes",
    "-o", "LogLevel=ERROR",
    `${user}@${opts.host}`,
    remoteCommand,
  ];

  const proc = Bun.spawn(args, {
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (opts.timeoutMs) {
    timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, opts.timeoutMs);
  }

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const decoder = new TextDecoder();

  async function consumeStream(
    stream: ReadableStream<Uint8Array>,
    label: "stdout" | "stderr",
    accumulator: string[]
  ) {
    const reader = stream.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        accumulator.push(text);
        opts.onChunk(text, label);
      }
    } finally {
      reader.releaseLock();
    }
  }

  await Promise.all([
    consumeStream(proc.stdout, "stdout", stdoutChunks),
    consumeStream(proc.stderr, "stderr", stderrChunks),
  ]);

  const exitCode = await proc.exited;
  if (timer) clearTimeout(timer);

  if (timedOut) {
    throw new Error(`SSH command timed out after ${opts.timeoutMs}ms`);
  }

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
    stderr: stderrChunks.join(""),
  };
}

function shellEscape(s: string): string {
  // Wrap in single quotes, escaping any existing single quotes
  return `'${s.replace(/'/g, "'\\''")}'`;
}
