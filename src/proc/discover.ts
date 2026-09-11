import { execFile } from 'node:child_process';

/**
 * Finds Warpline supervisor processes by asking the OS, rather than by reading
 * Warpline's own state.
 *
 * This exists to close a real gap: a detached supervisor lives independently of
 * the state file that describes it. Delete `~/.warpline/state`, restore a machine
 * image, or hit a corrupt write, and the supervisor keeps running while Warpline
 * has no record of it -- invisible to `status` and unreachable by `down`.
 * Scanning the process table is the only way back to a consistent picture.
 */
export interface DiscoveredSupervisor {
  pid: number;
  projectName: string;
  commandLine: string;
}

const SUPERVISE_MARKER = '__supervise';

function run(command: string, args: string[], timeoutMs = 5000): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(
        command,
        args,
        { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (error, stdout) => {
          if (error && !stdout) resolve(undefined);
          else resolve(stdout);
        },
      );
    } catch {
      resolve(undefined);
    }
  });
}

/** Pulls the value that followed `--name` on a supervisor command line. */
function extractProjectName(commandLine: string): string | undefined {
  const match = /--name\s+("([^"]+)"|'([^']+)'|(\S+))/.exec(commandLine);
  return match?.[2] ?? match?.[3] ?? match?.[4];
}

async function discoverWindows(): Promise<DiscoveredSupervisor[]> {
  // PowerShell's CIM query is the reliable way to read full command lines;
  // `wmic` is deprecated and absent on current Windows builds.
  const script =
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | " +
    'Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress';

  const stdout = await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 15_000);
  if (!stdout) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }

  // ConvertTo-Json emits a bare object when there is exactly one result.
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const results: DiscoveredSupervisor[] = [];

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const { ProcessId, CommandLine } = row as { ProcessId?: unknown; CommandLine?: unknown };
    if (typeof ProcessId !== 'number' || typeof CommandLine !== 'string') continue;
    if (!CommandLine.includes(SUPERVISE_MARKER)) continue;

    const projectName = extractProjectName(CommandLine);
    if (!projectName) continue;
    results.push({ pid: ProcessId, projectName, commandLine: CommandLine });
  }

  return results;
}

async function discoverPosix(): Promise<DiscoveredSupervisor[]> {
  const stdout = await run('ps', ['-eo', 'pid=,args=']);
  if (!stdout) return [];

  const results: DiscoveredSupervisor[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.includes(SUPERVISE_MARKER)) continue;

    const match = /^(\d+)\s+(.*)$/.exec(trimmed);
    if (!match?.[1] || !match[2]) continue;

    // `ps` output includes the grep-like scan itself in some shells; skip
    // anything that is not actually a node invocation of our binary.
    if (!/node/.test(match[2])) continue;

    const projectName = extractProjectName(match[2]);
    if (!projectName) continue;
    results.push({ pid: Number.parseInt(match[1], 10), projectName, commandLine: match[2] });
  }

  return results;
}

export async function discoverSupervisors(): Promise<DiscoveredSupervisor[]> {
  const found = process.platform === 'win32' ? await discoverWindows() : await discoverPosix();
  // Never report ourselves, which matters when a supervisor runs this scan.
  return found.filter((entry) => entry.pid !== process.pid);
}
