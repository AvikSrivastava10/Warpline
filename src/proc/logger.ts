import fs from 'node:fs';
import path from 'node:path';
import { ensureDir, paths } from '../core/paths.js';
import { colorForIndex, padEndVisible, theme } from '../core/ui.js';

export interface LoggerOptions {
  projectName: string;
  /** Mirror output to this process's stderr. False for detached supervisors. */
  toConsole: boolean;
  /** Prefix each line with the process label. */
  prefix: boolean;
  /** Rotate a log file once it exceeds this size. */
  maxFileBytes?: number;
  /** Lines retained in memory per process, for failure summaries. */
  ringSize?: number;
  /** Prefix each line with a wall-clock timestamp. */
  timestamps?: boolean;
}

interface Channel {
  id: string;
  label: string;
  colorize: (s: string) => string;
  stream: fs.WriteStream | undefined;
  file: string;
  bytesWritten: number;
  /** Holds an incomplete trailing line between chunks. */
  partial: string;
  flushTimer: NodeJS.Timeout | undefined;
  ring: string[];
}

const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_RING_SIZE = 60;
const PARTIAL_FLUSH_MS = 80;

/**
 * Fans process output out to three places at once: the user's terminal with an
 * aligned colour-coded prefix, a per-process log file for `warpline logs`, and a
 * small in-memory ring buffer so a crash report can show the last lines that
 * led up to the failure without re-reading the file.
 */
export class ProcessLogger {
  private readonly channels = new Map<string, Channel>();
  private readonly options: Required<Omit<LoggerOptions, 'projectName' | 'toConsole' | 'prefix'>> &
    Pick<LoggerOptions, 'projectName' | 'toConsole' | 'prefix'>;
  private prefixWidth = 0;
  private lastPrefixId: string | undefined;

  constructor(options: LoggerOptions) {
    this.options = {
      maxFileBytes: options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      ringSize: options.ringSize ?? DEFAULT_RING_SIZE,
      timestamps: options.timestamps ?? false,
      projectName: options.projectName,
      toConsole: options.toConsole,
      prefix: options.prefix,
    };
    ensureDir(paths.logDir(options.projectName));
  }

  register(id: string, label: string, index: number): string {
    const file = paths.logFile(this.options.projectName, id);
    ensureDir(path.dirname(file));

    let bytesWritten = 0;
    try {
      bytesWritten = fs.statSync(file).size;
    } catch {
      bytesWritten = 0;
    }

    const channel: Channel = {
      id,
      label,
      colorize: colorForIndex(index),
      stream: fs.createWriteStream(file, { flags: 'a' }),
      file,
      bytesWritten,
      partial: '',
      flushTimer: undefined,
      ring: [],
    };

    this.channels.set(id, channel);
    this.prefixWidth = Math.max(this.prefixWidth, label.length);

    const stamp = new Date().toISOString();
    channel.stream?.write(`\n=== warpline session ${stamp} ===\n`);

    return file;
  }

  logFileFor(id: string): string | undefined {
    return this.channels.get(id)?.file;
  }

  /** Feeds raw child output in. Chunks are re-assembled into whole lines. */
  write(id: string, chunk: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;

    this.appendToFile(channel, chunk);

    // Normalise CR-only progress output so spinners do not eat real lines.
    const normalized = (channel.partial + chunk).replace(/\r\n/g, '\n').replace(/\r(?!\n)/g, '\n');
    const segments = normalized.split('\n');
    channel.partial = segments.pop() ?? '';

    for (const line of segments) {
      this.emitLine(channel, line);
    }

    // A prompt or spinner may never send a newline; flush it after a short idle
    // period so the terminal is not left looking stalled.
    if (channel.flushTimer) clearTimeout(channel.flushTimer);
    if (channel.partial.length > 0) {
      channel.flushTimer = setTimeout(() => {
        if (channel.partial.length > 0) {
          this.emitLine(channel, channel.partial);
          channel.partial = '';
        }
      }, PARTIAL_FLUSH_MS);
      if (typeof channel.flushTimer.unref === 'function') channel.flushTimer.unref();
    }
  }

  /** Emits a Warpline-authored line attributed to a process. */
  note(id: string, text: string): void {
    const channel = this.channels.get(id);
    if (!channel) return;
    this.appendToFile(channel, `[warpline] ${text}\n`);
    this.emitLine(channel, theme.dim(`[warpline] ${text}`), false);
  }

  private emitLine(channel: Channel, line: string, record = true): void {
    if (record) {
      channel.ring.push(line);
      if (channel.ring.length > this.options.ringSize) channel.ring.shift();
    }

    if (!this.options.toConsole) return;

    let rendered = line;
    if (this.options.prefix) {
      const label = padEndVisible(channel.label, this.prefixWidth);
      rendered = `${channel.colorize(label)} ${theme.dim('|')} ${line}`;
    }
    if (this.options.timestamps) {
      const time = new Date().toTimeString().slice(0, 8);
      rendered = `${theme.dim(time)} ${rendered}`;
    }

    // A blank separator when output switches processes makes interleaved logs
    // dramatically easier to scan.
    if (this.options.prefix && this.lastPrefixId !== undefined && this.lastPrefixId !== channel.id) {
      process.stderr.write('\n');
    }
    this.lastPrefixId = channel.id;

    process.stderr.write(rendered + '\n');
  }

  private appendToFile(channel: Channel, text: string): void {
    if (!channel.stream) return;
    channel.stream.write(text);
    channel.bytesWritten += Buffer.byteLength(text);
    if (channel.bytesWritten > this.options.maxFileBytes) this.rotate(channel);
  }

  /**
   * Single-generation rotation. A dev server left running for days can emit
   * gigabytes; keeping one previous file bounds disk use while preserving
   * enough history to debug what just happened.
   */
  private rotate(channel: Channel): void {
    const stream = channel.stream;
    channel.stream = undefined;
    stream?.end();

    try {
      fs.rmSync(`${channel.file}.1`, { force: true });
      fs.renameSync(channel.file, `${channel.file}.1`);
    } catch {
      /* if rotation fails, keep appending to the current file */
    }

    channel.stream = fs.createWriteStream(channel.file, { flags: 'a' });
    channel.bytesWritten = 0;
  }

  /** Last retained lines for a process, used in failure summaries. */
  tail(id: string, count: number): string[] {
    const channel = this.channels.get(id);
    if (!channel) return [];
    return channel.ring.slice(-count);
  }

  async close(): Promise<void> {
    const closes: Array<Promise<void>> = [];

    for (const channel of this.channels.values()) {
      if (channel.flushTimer) clearTimeout(channel.flushTimer);
      if (channel.partial.length > 0) {
        this.emitLine(channel, channel.partial);
        this.appendToFile(channel, channel.partial + '\n');
        channel.partial = '';
      }
      const stream = channel.stream;
      channel.stream = undefined;
      if (!stream) continue;
      closes.push(
        new Promise<void>((resolve) => {
          stream.end(() => resolve());
        }),
      );
    }

    await Promise.all(closes);
  }
}

/** Reads the tail of a log file without loading the whole thing into memory. */
export function readLogTail(file: string, lines: number): string[] {
  let handle: number | undefined;
  try {
    handle = fs.openSync(file, 'r');
    const size = fs.fstatSync(handle).size;
    const chunkSize = 64 * 1024;
    let position = size;
    let buffer = '';
    let found = 0;

    while (position > 0 && found <= lines) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const chunk = Buffer.alloc(readSize);
      fs.readSync(handle, chunk, 0, readSize, position);
      const text = chunk.toString('utf8');
      buffer = text + buffer;
      found = (buffer.match(/\n/g) ?? []).length;
    }

    const all = buffer.split(/\r?\n/);
    if (all[all.length - 1] === '') all.pop();
    return all.slice(-lines);
  } catch {
    return [];
  } finally {
    if (handle !== undefined) {
      try {
        fs.closeSync(handle);
      } catch {
        /* ignore */
      }
    }
  }
}
