import path from 'node:path';
import os from 'node:os';
import { flagBool, flagString, parseArgs, renderFlagHelp, type FlagSpecs } from '../core/args.js';
import { WarplineError } from '../core/errors.js';
import { out, theme } from '../core/ui.js';
import { COMMAND_NAMES, PROJECT_ARG_COMMANDS } from './names.js';

export type SupportedShell = 'bash' | 'zsh' | 'fish' | 'powershell';

export const shellInitFlags: FlagSpecs = {
  shell: { type: 'string', alias: 's', choices: ['bash', 'zsh', 'fish', 'powershell'], describe: 'Target shell (auto-detected by default)' },
  'no-completion': { type: 'boolean', describe: 'Emit only the wrapper function, without tab completion' },
  instructions: { type: 'boolean', alias: 'i', describe: 'Print installation instructions instead of the script' },
};

export function shellInitHelp(): string {
  return [
    `${theme.bold('warpline shell-init')} ${theme.dim('[options]')}`,
    '',
    'Emits a shell function that makes `warpline cd` change your shell\'s directory,',
    'plus tab completion for commands and saved project names.',
    '',
    'A child process cannot change its parent shell\'s working directory, so this',
    'wrapper is the only way `warpline cd` can work. Everything else in Warpline runs',
    'fine without it.',
    '',
    theme.dim('Install (add to your shell startup file):'),
    `  bash        ${theme.code('echo \'eval "$(warpline shell-init --shell bash)"\' >> ~/.bashrc')}`,
    `  zsh         ${theme.code('echo \'eval "$(warpline shell-init --shell zsh)"\' >> ~/.zshrc')}`,
    `  fish        ${theme.code('warpline shell-init --shell fish > ~/.config/fish/conf.d/warpline.fish')}`,
    `  powershell  ${theme.code('warpline shell-init --shell powershell >> $PROFILE')}`,
    '',
    theme.dim('Options:'),
    ...renderFlagHelp(shellInitFlags),
  ].join('\n');
}

/** Best-effort shell detection from the environment. */
export function detectShell(): SupportedShell {
  if (process.env.FISH_VERSION) return 'fish';
  if (process.env.ZSH_VERSION) return 'zsh';
  if (process.env.BASH_VERSION) return 'bash';
  if (process.env.PSModulePath && process.platform === 'win32') return 'powershell';

  const shellPath = process.env.SHELL;
  if (shellPath) {
    const base = path.basename(shellPath).toLowerCase();
    if (base.includes('fish')) return 'fish';
    if (base.includes('zsh')) return 'zsh';
    if (base.includes('bash')) return 'bash';
    if (base.includes('pwsh')) return 'powershell';
  }

  return process.platform === 'win32' ? 'powershell' : 'bash';
}

const COMMAND_LIST = COMMAND_NAMES.join(' ');
const PROJECT_COMMAND_LIST = PROJECT_ARG_COMMANDS.join(' ');

function bashScript(withCompletion: boolean): string {
  const lines = [
    '# warpline shell integration (bash)',
    'warpline() {',
    '  if [ "$1" = "cd" ]; then',
    '    shift',
    '    local __warpline_target',
    '    __warpline_target="$(command warpline cd --quiet "$@")" || return $?',
    '    if [ -n "$__warpline_target" ]; then',
    '      cd "$__warpline_target" || return $?',
    '    fi',
    '  else',
    '    command warpline "$@"',
    '  fi',
    '}',
    'export WARPLINE_SHELL_INTEGRATION=1',
  ];

  if (withCompletion) {
    lines.push(
      '',
      '_warpline_completions() {',
      '  local cur prev',
      '  cur="${COMP_WORDS[COMP_CWORD]}"',
      '  prev="${COMP_WORDS[1]}"',
      '  if [ "$COMP_CWORD" -eq 1 ]; then',
      `    COMPREPLY=($(compgen -W "${COMMAND_LIST}" -- "$cur"))`,
      '    return',
      '  fi',
      `  case " ${PROJECT_COMMAND_LIST} " in`,
      '    *" $prev "*)',
      '      COMPREPLY=($(compgen -W "$(command warpline list --names 2>/dev/null)" -- "$cur"))',
      '      return',
      '      ;;',
      '  esac',
      '}',
      'complete -F _warpline_completions warpline',
    );
  }

  return lines.join('\n') + '\n';
}

function zshScript(withCompletion: boolean): string {
  const lines = [
    '# warpline shell integration (zsh)',
    'warpline() {',
    '  if [[ "$1" == "cd" ]]; then',
    '    shift',
    '    local __warpline_target',
    '    __warpline_target="$(command warpline cd --quiet "$@")" || return $?',
    '    if [[ -n "$__warpline_target" ]]; then',
    '      builtin cd "$__warpline_target" || return $?',
    '    fi',
    '  else',
    '    command warpline "$@"',
    '  fi',
    '}',
    'export WARPLINE_SHELL_INTEGRATION=1',
  ];

  if (withCompletion) {
    lines.push(
      '',
      '_warpline() {',
      '  local -a __warpline_commands __warpline_projects',
      `  __warpline_commands=(${COMMAND_LIST})`,
      '  if (( CURRENT == 2 )); then',
      '    compadd -- $__warpline_commands',
      '    return',
      '  fi',
      `  if [[ " ${PROJECT_COMMAND_LIST} " == *" \${words[2]} "* ]]; then`,
      '    __warpline_projects=(${(f)"$(command warpline list --names 2>/dev/null)"})',
      '    compadd -- $__warpline_projects',
      '  fi',
      '}',
      'compdef _warpline warpline',
    );
  }

  return lines.join('\n') + '\n';
}

function fishScript(withCompletion: boolean): string {
  const lines = [
    '# warpline shell integration (fish)',
    'function warpline --description "Warpline project launcher"',
    '    if test (count $argv) -gt 0 -a "$argv[1]" = "cd"',
    '        set -l __warpline_target (command warpline cd --quiet $argv[2..-1])',
    '        or return $status',
    '        if test -n "$__warpline_target"',
    '            cd $__warpline_target',
    '        end',
    '    else',
    '        command warpline $argv',
    '    end',
    'end',
    'set -gx WARPLINE_SHELL_INTEGRATION 1',
  ];

  if (withCompletion) {
    lines.push(
      '',
      `complete -c warpline -f -n __fish_use_subcommand -a "${COMMAND_LIST}"`,
      `for __warpline_cmd in ${PROJECT_COMMAND_LIST}`,
      '    complete -c warpline -f -n "__fish_seen_subcommand_from $__warpline_cmd" -a "(command warpline list --names 2>/dev/null)"',
      'end',
    );
  }

  return lines.join('\n') + '\n';
}

function powershellScript(withCompletion: boolean): string {
  const lines = [
    '# warpline shell integration (PowerShell)',
    '$script:WarplineExe = (Get-Command warpline -CommandType Application -ErrorAction SilentlyContinue |',
    '    Select-Object -First 1).Source',
    '',
    'if (-not $script:WarplineExe) {',
    '    Write-Warning "warpline was not found on PATH; shell integration is inactive."',
    '} else {',
    '    function warpline {',
    '        if ($args.Count -gt 0 -and $args[0] -eq "cd") {',
    '            $rest = @()',
    '            if ($args.Count -gt 1) { $rest = $args[1..($args.Count - 1)] }',
    '            $target = & $script:WarplineExe cd --quiet @rest',
    '            if ($LASTEXITCODE -eq 0 -and $target) {',
    '                Set-Location -LiteralPath ($target | Select-Object -Last 1)',
    '            }',
    '        } else {',
    '            & $script:WarplineExe @args',
    '        }',
    '    }',
    '    $env:WARPLINE_SHELL_INTEGRATION = "1"',
  ];

  if (withCompletion) {
    lines.push(
      '',
      '    Register-ArgumentCompleter -CommandName warpline -Native -ScriptBlock {',
      '        param($wordToComplete, $commandAst, $cursorPosition)',
      `        $commands = "${COMMAND_LIST}".Split(" ")`,
      `        $projectCommands = "${PROJECT_COMMAND_LIST}".Split(" ")`,
      '        $tokens = $commandAst.CommandElements | ForEach-Object { $_.ToString() }',
      '        if ($tokens.Count -le 1 -or ($tokens.Count -eq 2 -and $wordToComplete)) {',
      '            $commands | Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
      '                [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
      '            }',
      '            return',
      '        }',
      '        if ($projectCommands -contains $tokens[1]) {',
      '            (& $script:WarplineExe list --names 2>$null) |',
      '                Where-Object { $_ -like "$wordToComplete*" } | ForEach-Object {',
      '                    [System.Management.Automation.CompletionResult]::new($_, $_, "ParameterValue", $_)',
      '                }',
      '        }',
      '    }',
    );
  }

  lines.push('}');
  return lines.join('\n') + '\n';
}

function instructionsFor(shell: SupportedShell): string[] {
  const home = os.homedir();
  switch (shell) {
    case 'fish':
      return [
        'Add to fish by writing a conf.d snippet:',
        '',
        `  ${theme.code('warpline shell-init --shell fish > ~/.config/fish/conf.d/warpline.fish')}`,
        '',
        'Then open a new shell, or run:',
        `  ${theme.code('source ~/.config/fish/conf.d/warpline.fish')}`,
      ];
    case 'zsh':
      return [
        `Add this line to ${path.join(home, '.zshrc')}:`,
        '',
        `  ${theme.code('eval "$(warpline shell-init --shell zsh)"')}`,
        '',
        'Then open a new shell, or run:',
        `  ${theme.code('source ~/.zshrc')}`,
      ];
    case 'powershell':
      return [
        'Append to your PowerShell profile:',
        '',
        `  ${theme.code('warpline shell-init --shell powershell >> $PROFILE')}`,
        '',
        'Then open a new shell, or run:',
        `  ${theme.code('. $PROFILE')}`,
        '',
        theme.dim('If $PROFILE does not exist yet:'),
        `  ${theme.code('New-Item -ItemType File -Path $PROFILE -Force')}`,
      ];
    default:
      return [
        `Add this line to ${path.join(home, '.bashrc')}:`,
        '',
        `  ${theme.code('eval "$(warpline shell-init --shell bash)"')}`,
        '',
        'Then open a new shell, or run:',
        `  ${theme.code('source ~/.bashrc')}`,
      ];
  }
}

export function generateShellScript(shell: SupportedShell, withCompletion: boolean): string {
  switch (shell) {
    case 'bash':
      return bashScript(withCompletion);
    case 'zsh':
      return zshScript(withCompletion);
    case 'fish':
      return fishScript(withCompletion);
    case 'powershell':
      return powershellScript(withCompletion);
    default:
      throw new WarplineError(`Unsupported shell: ${String(shell)}`);
  }
}

export async function runShellInit(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, shellInitFlags);

  const requested = (flagString(parsed, 'shell') ?? parsed.positionals[0]) as SupportedShell | undefined;
  const shell = requested ?? detectShell();

  if (!['bash', 'zsh', 'fish', 'powershell'].includes(shell)) {
    throw new WarplineError(`Unsupported shell: ${shell}`, {
      hint: 'Supported: bash, zsh, fish, powershell',
    });
  }

  if (flagBool(parsed, 'instructions')) {
    out.write(`${theme.bold('Shell integration')} ${theme.dim(`(${shell})`)}`);
    out.blank();
    for (const line of instructionsFor(shell)) out.write(line);
    return 0;
  }

  // The script goes to stdout so it can be eval'd; the guidance goes to stderr
  // so it never ends up inside the eval.
  out.write(generateShellScript(shell, !flagBool(parsed, 'no-completion')));

  if (process.stderr.isTTY && !requested) {
    out.note('');
    out.note(`detected ${shell}; run \`warpline shell-init --instructions\` to see how to install this permanently`);
  }

  return 0;
}
