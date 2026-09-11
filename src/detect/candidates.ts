import path from 'node:path';
import YAML from 'yaml';
import { readTextOrNull } from '../core/fsx.js';
import {
  allDependencies,
  detectNodeVersionPin,
  detectPackageManager,
  detectWorkspaces,
  findComposeFile,
  readPackageJson,
  runScriptCommand,
  scanEnvFiles,
  type EnvFileScan,
  type PackageJson,
  type PackageManager,
  type WorkspacePackage,
} from './project.js';

export type CandidateSource = 'script' | 'workspace-script' | 'procfile' | 'compose';

export interface ProcessCandidate {
  id: string;
  command: string;
  /** POSIX-style path relative to the project root, or undefined for the root. */
  cwd: string | undefined;
  kind: 'service' | 'task';
  port: number | undefined;
  readyLog: string | undefined;
  source: CandidateSource;
  /** Higher means "more likely what the user wants running". */
  score: number;
  /** Shown next to the candidate during `warpline init`. */
  detail: string;
  /** Pre-ticked in the init picker. */
  recommended: boolean;
}

/**
 * Default dev-server ports and readiness log patterns per framework. Getting
 * these right is what makes `warpline init` produce a config with working
 * readiness gating instead of a pile of blind `sleep`s.
 */
const FRAMEWORK_SIGNATURES: ReadonlyArray<{
  deps: string[];
  port: number;
  readyLog?: string;
  label: string;
}> = [
  { deps: ['next'], port: 3000, readyLog: 'ready|started server|Local:', label: 'Next.js' },
  { deps: ['nuxt', 'nuxt3'], port: 3000, readyLog: 'Local:|listening', label: 'Nuxt' },
  { deps: ['@remix-run/dev', '@remix-run/serve'], port: 3000, readyLog: 'Remix App Server started|http://localhost', label: 'Remix' },
  { deps: ['@sveltejs/kit'], port: 5173, readyLog: 'Local:|ready in', label: 'SvelteKit' },
  { deps: ['astro'], port: 4321, readyLog: 'ready in|Local', label: 'Astro' },
  { deps: ['vite'], port: 5173, readyLog: 'ready in|Local:', label: 'Vite' },
  { deps: ['react-scripts'], port: 3000, readyLog: 'Compiled successfully|On Your Network', label: 'Create React App' },
  { deps: ['@angular/cli', '@angular-devkit/build-angular'], port: 4200, readyLog: 'Compiled successfully|Application bundle generation complete', label: 'Angular' },
  { deps: ['@vue/cli-service'], port: 8080, readyLog: 'App running at|Compiled successfully', label: 'Vue CLI' },
  { deps: ['gatsby'], port: 8000, readyLog: 'You can now view|success Building development bundle', label: 'Gatsby' },
  { deps: ['@docusaurus/core'], port: 3000, readyLog: 'Docusaurus website is running', label: 'Docusaurus' },
  { deps: ['parcel'], port: 1234, readyLog: 'Server running at', label: 'Parcel' },
  { deps: ['webpack-dev-server'], port: 8080, readyLog: 'compiled successfully|Project is running at', label: 'webpack-dev-server' },
  { deps: ['@nestjs/core'], port: 3000, readyLog: 'Nest application successfully started', label: 'NestJS' },
  { deps: ['@medusajs/medusa'], port: 9000, readyLog: 'Server is ready', label: 'Medusa' },
  { deps: ['@strapi/strapi', 'strapi'], port: 1337, readyLog: 'To manage your project', label: 'Strapi' },
  { deps: ['payload'], port: 3000, readyLog: 'Payload Admin URL', label: 'Payload' },
  { deps: ['fastify'], port: 3000, readyLog: 'Server listening|listening on', label: 'Fastify' },
  { deps: ['express'], port: 3000, readyLog: 'listening|Listening on', label: 'Express' },
  { deps: ['koa'], port: 3000, readyLog: 'listening', label: 'Koa' },
  { deps: ['hono'], port: 3000, readyLog: 'Listening on|Server is running', label: 'Hono' },
  { deps: ['@hapi/hapi'], port: 3000, readyLog: 'Server running', label: 'hapi' },
  { deps: ['storybook', '@storybook/cli', '@storybook/react'], port: 6006, readyLog: 'Storybook.*started|Local:', label: 'Storybook' },
];

/** Scripts whose names imply a long-running process rather than a one-shot task. */
const SERVICE_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /^dev$/, score: 100 },
  { pattern: /^start:dev$/, score: 95 },
  { pattern: /^dev:/, score: 90 },
  { pattern: /^start$/, score: 85 },
  { pattern: /^serve$/, score: 80 },
  { pattern: /^start:/, score: 75 },
  { pattern: /^serve:/, score: 70 },
  { pattern: /^watch$/, score: 60 },
  { pattern: /^watch:/, score: 55 },
  { pattern: /^storybook$/, score: 40 },
  { pattern: /^(api|server|backend|web|frontend|client|worker|queue)$/, score: 88 },
];

/** Scripts that are useful in a graph as gating tasks, not as services. */
const TASK_NAME_PATTERNS: ReadonlyArray<{ pattern: RegExp; score: number }> = [
  { pattern: /^(db:)?migrate$/, score: 30 },
  { pattern: /^(db:)?(seed|setup|prepare)$/, score: 25 },
  { pattern: /^prisma:(migrate|generate)$/, score: 25 },
  { pattern: /^generate$/, score: 15 },
  { pattern: /^codegen$/, score: 15 },
  { pattern: /^build$/, score: 10 },
];

const NEVER_SUGGEST = /^(test|lint|format|prettier|eslint|typecheck|tsc|clean|postinstall|preinstall|prepare|prepublishOnly|release|publish|deploy|bench|coverage)(:|$)/;

/**
 * Extracts an explicit port from a command string. Covers the common shapes:
 * `--port 4000`, `--port=4000`, `-p 4000`, and a leading `PORT=4000`.
 */
export function extractPortFromCommand(command: string): number | undefined {
  const patterns = [
    /--port[=\s]+(\d{2,5})\b/i,
    /(?:^|\s)-p[=\s]+(\d{2,5})\b/,
    /(?:^|\s)PORT=(\d{2,5})\b/,
    /--listen[=\s]+(?:\S*:)?(\d{2,5})\b/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(command);
    const captured = match?.[1];
    if (captured) {
      const port = Number.parseInt(captured, 10);
      if (port >= 1 && port <= 65535) return port;
    }
  }
  return undefined;
}

/** Which framework a package depends on. Informational only. */
function frameworkFromDeps(pkg: PackageJson | undefined) {
  const deps = allDependencies(pkg);
  return FRAMEWORK_SIGNATURES.find((signature) => signature.deps.some((dep) => dep in deps));
}

/** Which framework a specific command actually invokes. */
function frameworkFromCommand(command: string) {
  return FRAMEWORK_SIGNATURES.find((signature) =>
    signature.deps.some((dep) => new RegExp(`(^|[\\s/])${escapeRegex(dep)}([\\s]|$)`).test(command)),
  );
}

/** Script names canonical enough to inherit a framework's default port. */
const CANONICAL_ENTRYPOINTS = new Set(['dev', 'start', 'serve']);

/**
 * Picks the framework whose default port and readiness pattern should apply to
 * one script.
 *
 * The command is checked first, and dependency-based guessing is limited to the
 * canonical entrypoint scripts. Without that limit, every script in a Next.js
 * package inherits port 3000 -- so a `dev:worker` that binds nothing at all gets
 * handed the web server's port, and two processes end up claiming it.
 */
function frameworkForScript(pkg: PackageJson | undefined, scriptName: string, command: string) {
  const fromCommand = frameworkFromCommand(command);
  if (fromCommand) return fromCommand;
  if (CANONICAL_ENTRYPOINTS.has(scriptName)) return frameworkFromDeps(pkg);
  return undefined;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function classifyScript(name: string): { kind: 'service' | 'task'; score: number } | undefined {
  if (NEVER_SUGGEST.test(name)) return undefined;
  for (const entry of SERVICE_NAME_PATTERNS) {
    if (entry.pattern.test(name)) return { kind: 'service', score: entry.score };
  }
  for (const entry of TASK_NAME_PATTERNS) {
    if (entry.pattern.test(name)) return { kind: 'task', score: entry.score };
  }
  return undefined;
}

function candidateIdFor(base: string, used: Set<string>): string {
  const cleaned = base
    .replace(/[^a-zA-Z0-9_.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const seed = cleaned.length > 0 ? cleaned : 'proc';
  if (!used.has(seed)) {
    used.add(seed);
    return seed;
  }
  for (let i = 2; ; i += 1) {
    const candidate = `${seed}-${i}`;
    if (!used.has(candidate)) {
      used.add(candidate);
      return candidate;
    }
  }
}

function candidatesFromScripts(
  pkg: PackageJson | undefined,
  manager: PackageManager | undefined,
  relativeDir: string | undefined,
  used: Set<string>,
  source: CandidateSource,
  scorePenalty: number,
): ProcessCandidate[] {
  const scripts = pkg?.scripts ?? {};
  const results: ProcessCandidate[] = [];

  for (const [name, body] of Object.entries(scripts)) {
    if (typeof body !== 'string') continue;
    const classified = classifyScript(name);
    if (!classified) continue;

    const framework = frameworkForScript(pkg, name, body);
    const explicitPort = extractPortFromCommand(body);
    const port = classified.kind === 'service' ? (explicitPort ?? framework?.port) : undefined;

    const idBase = relativeDir ? `${path.basename(relativeDir)}${name === 'dev' ? '' : `-${name}`}` : name;

    const detailBits = [source === 'workspace-script' ? `${relativeDir}` : 'package.json'];
    if (framework) detailBits.push(framework.label);
    if (port) detailBits.push(`:${port}`);

    results.push({
      id: candidateIdFor(idBase, used),
      command: runScriptCommand(manager, name),
      cwd: relativeDir,
      kind: classified.kind,
      port,
      readyLog: classified.kind === 'service' && !port ? framework?.readyLog : undefined,
      source,
      score: Math.max(1, classified.score - scorePenalty),
      detail: detailBits.join(' '),
      recommended: classified.kind === 'service' && classified.score >= 75,
    });
  }

  return results;
}

/** `web: npm start` style lines, the Heroku/foreman convention. */
function candidatesFromProcfile(root: string, used: Set<string>): ProcessCandidate[] {
  const text = readTextOrNull(path.join(root, 'Procfile')) ?? readTextOrNull(path.join(root, 'Procfile.dev'));
  if (text === null) return [];

  const results: ProcessCandidate[] = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const match = /^([A-Za-z0-9_-]+):\s*(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, name, command] = match;
    if (!name || !command) continue;

    results.push({
      id: candidateIdFor(name, used),
      command: command.trim(),
      cwd: undefined,
      kind: 'service',
      port: extractPortFromCommand(command),
      readyLog: undefined,
      source: 'procfile',
      score: 95,
      detail: 'Procfile',
      recommended: true,
    });
  }
  return results;
}

const DATASTORE_IMAGES: ReadonlyArray<{ pattern: RegExp; label: string; port: number }> = [
  { pattern: /(^|\/)postgres/i, label: 'Postgres', port: 5432 },
  { pattern: /(^|\/)(mysql|mariadb)/i, label: 'MySQL', port: 3306 },
  { pattern: /(^|\/)redis/i, label: 'Redis', port: 6379 },
  { pattern: /(^|\/)mongo/i, label: 'MongoDB', port: 27017 },
  { pattern: /(^|\/)(rabbitmq)/i, label: 'RabbitMQ', port: 5672 },
  { pattern: /(^|\/)(elasticsearch|opensearch)/i, label: 'Elasticsearch', port: 9200 },
  { pattern: /(^|\/)(minio)/i, label: 'MinIO', port: 9000 },
  { pattern: /(^|\/)(clickhouse)/i, label: 'ClickHouse', port: 8123 },
  { pattern: /(^|\/)(nats)/i, label: 'NATS', port: 4222 },
  { pattern: /(^|\/)(localstack)/i, label: 'LocalStack', port: 4566 },
];

/**
 * Backing services in compose are the single most common "I forgot to start
 * the database" failure, so they are surfaced as first-class candidates with a
 * port readiness probe rather than left to a hook.
 */
function candidatesFromCompose(root: string, used: Set<string>): ProcessCandidate[] {
  const composeFile = findComposeFile(root);
  if (!composeFile) return [];

  const text = readTextOrNull(path.join(root, composeFile));
  if (text === null) return [];

  let parsed: { services?: Record<string, unknown> };
  try {
    parsed = YAML.parse(text) as { services?: Record<string, unknown> };
  } catch {
    return [];
  }

  const services = parsed?.services;
  if (typeof services !== 'object' || services === null) return [];

  const results: ProcessCandidate[] = [];
  for (const [name, raw] of Object.entries(services)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const service = raw as { image?: unknown; ports?: unknown };
    const image = typeof service.image === 'string' ? service.image : '';
    const known = DATASTORE_IMAGES.find((entry) => entry.pattern.test(image) || entry.pattern.test(name));
    if (!known) continue;

    // Prefer the published host port, since that is what the app connects to.
    let hostPort = known.port;
    if (Array.isArray(service.ports)) {
      for (const mapping of service.ports) {
        if (typeof mapping !== 'string' && typeof mapping !== 'number') continue;
        const asText = String(mapping);
        const match = /^(?:[\d.]+:)?(\d{2,5}):(\d{2,5})/.exec(asText);
        if (match?.[1]) {
          hostPort = Number.parseInt(match[1], 10);
          break;
        }
      }
    }

    results.push({
      id: candidateIdFor(name, used),
      command: `docker compose up ${name}`,
      cwd: undefined,
      kind: 'service',
      port: hostPort,
      readyLog: undefined,
      source: 'compose',
      score: 120, // datastores should start first, so they rank above app servers
      detail: `${composeFile} ${known.label} :${hostPort}`,
      recommended: true,
    });
  }

  return results;
}

export interface DetectionResult {
  root: string;
  suggestedName: string;
  packageManager: PackageManager | undefined;
  candidates: ProcessCandidate[];
  env: EnvFileScan;
  workspaces: WorkspacePackage[];
  composeFile: string | undefined;
  nodePin: { source: string; range: string } | undefined;
  framework: string | undefined;
}

/**
 * Inspects a directory and returns everything `warpline init` and
 * `warpline doctor` need. Pure inspection: nothing is written.
 */
export function detectProject(root: string): DetectionResult {
  const pkg = readPackageJson(root);
  const manager = detectPackageManager(root);
  const workspaces = detectWorkspaces(root);
  const used = new Set<string>();

  // Order matters: compose first so datastores claim their natural ids.
  const candidates: ProcessCandidate[] = [
    ...candidatesFromCompose(root, used),
    ...candidatesFromProcfile(root, used),
    ...candidatesFromScripts(pkg, manager, undefined, used, 'script', 0),
  ];

  for (const workspace of workspaces) {
    candidates.push(
      ...candidatesFromScripts(workspace.pkg, manager, workspace.relativeDir, used, 'workspace-script', 5),
    );
  }

  candidates.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  // Safety net: two candidates must never claim the same port. Where inference
  // collides, the higher-scored candidate keeps the port and the other falls
  // back to a log or settle probe.
  const claimedPorts = new Set<number>();
  for (const candidate of candidates) {
    if (candidate.port === undefined) continue;
    if (claimedPorts.has(candidate.port)) {
      candidate.port = undefined;
    } else {
      claimedPorts.add(candidate.port);
    }
  }

  const suggestedName = (pkg?.name ?? path.basename(root))
    .replace(/^@[^/]+\//, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .toLowerCase();

  const framework = frameworkFromDeps(pkg)?.label;

  return {
    root,
    suggestedName: suggestedName.length > 0 ? suggestedName : 'project',
    packageManager: manager,
    candidates,
    env: scanEnvFiles(root),
    workspaces,
    composeFile: findComposeFile(root),
    nodePin: detectNodeVersionPin(root),
    framework,
  };
}
