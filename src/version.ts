import fs from 'node:fs';

/**
 * Read from package.json at runtime rather than baked in by the build, so the
 * reported version can never drift from what npm actually installed.
 */
export function getVersion(): string {
  try {
    const url = new URL('../package.json', import.meta.url);
    const parsed = JSON.parse(fs.readFileSync(url, 'utf8')) as { version?: string };
    return parsed.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
