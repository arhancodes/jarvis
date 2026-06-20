import type { JarvisModule, ParsedCommand, CommandResult, PatternDefinition } from '../core/types.js';
import { llmStreamChat } from '../utils/llm.js';
import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { homedir } from 'os';

const MAX_ITERATIONS = 5;

interface FileEdit {
  file: string;
  content: string;
}

interface CodingPlan {
  edits: FileEdit[];
  test_command: string;
  commit_message: string;
}

const CODING_SYSTEM_PROMPT = `You are an autonomous coding agent working inside an existing codebase. The user will provide you with:
1. The project structure (file listing)
2. Contents of key files
3. A task to accomplish

You must respond with ONLY valid JSON (no markdown, no backticks, no explanation) in this exact format:
{
  "edits": [
    {"file": "relative/path/to/file", "content": "full file content"}
  ],
  "test_command": "npm test",
  "commit_message": "descriptive commit message"
}

Rules:
- Only include files that need to be created or modified
- File paths are relative to the project root
- "content" must be the COMPLETE file content, not a diff
- Detect the project type and set the right test_command (npm test, python -m pytest, cargo test, go test ./..., etc.)
- If no obvious test command, use a build/lint command instead (npm run build, tsc --noEmit, python -c "import module", etc.)
- The commit message should clearly describe what was changed and why
- Keep changes minimal and focused on the task`;

const FIX_SYSTEM_PROMPT = `You are an autonomous coding agent fixing build/test errors. The user will provide:
1. The current code (files that were edited)
2. The error output from running tests/build
3. The original task description

You must respond with ONLY valid JSON (no markdown, no backticks, no explanation) in the same format:
{
  "edits": [
    {"file": "relative/path/to/file", "content": "full file content"}
  ],
  "test_command": "npm test",
  "commit_message": "descriptive commit message"
}

Fix the errors while staying true to the original task. Only include files that need changes.`;

function resolvePath(input: string): string {
  if (input.startsWith('~')) return input.replace('~', homedir());
  if (input.startsWith('/')) return input;
  return join(process.cwd(), input);
}

function runCommand(cmd: string, cwd: string, timeoutMs = 60_000): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1' },
    });
    return { ok: true, output: output ?? '' };
  } catch (err: unknown) {
    const e = err as { stderr?: string; stdout?: string; message?: string };
    const output = (e.stdout || '') + (e.stderr || '');
    return { ok: false, output: output || e.message || 'Unknown error' };
  }
}

function scanProject(projectDir: string): string {
  try {
    const files = execSync(
      `find . -maxdepth 4 -type f \\( -name "*.ts" -o -name "*.js" -o -name "*.py" -o -name "*.go" -o -name "*.rs" -o -name "*.java" -o -name "*.jsx" -o -name "*.tsx" -o -name "*.json" -o -name "*.yaml" -o -name "*.yml" -o -name "*.toml" \\) ! -path "*/node_modules/*" ! -path "*/.git/*" ! -path "*/dist/*" ! -path "*/build/*" ! -path "*/__pycache__/*" ! -path "*/target/*" | head -100`,
      { cwd: projectDir, encoding: 'utf-8', timeout: 10_000 },
    ).trim();
    return files || '(no source files found)';
  } catch {
    return '(failed to scan project)';
  }
}

function readKeyFiles(projectDir: string, fileList: string): string {
  const files = fileList.split('\n').filter(f => f.trim());
  // Prioritize config files and entry points
  const priority = ['package.json', 'tsconfig.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'Makefile'];
  const sorted = [
    ...files.filter(f => priority.some(p => f.endsWith(p))),
    ...files.filter(f => !priority.some(p => f.endsWith(p))),
  ];

  const contents: string[] = [];
  let totalChars = 0;
  const MAX_CHARS = 12_000;

  for (const file of sorted.slice(0, 20)) {
    const fullPath = join(projectDir, file.replace(/^\.\//, ''));
    try {
      const content = readFileSync(fullPath, 'utf-8');
      if (totalChars + content.length > MAX_CHARS) {
        if (contents.length === 0) {
          contents.push(`--- ${file} ---\n${content.slice(0, MAX_CHARS)}\n(truncated)`);
        }
        break;
      }
      contents.push(`--- ${file} ---\n${content}`);
      totalChars += content.length;
    } catch {
      // skip unreadable files
    }
  }
  return contents.join('\n\n');
}

function parsePlan(raw: string): CodingPlan {
  let cleaned = raw.trim();
  if (cleaned.includes('```')) {
    const jsonBlock = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
    if (jsonBlock) cleaned = jsonBlock[1];
  }
  if (!cleaned.startsWith('{')) {
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end !== -1) cleaned = cleaned.slice(start, end + 1);
  }
  return JSON.parse(cleaned) as CodingPlan;
}

function applyEdits(projectDir: string, edits: FileEdit[]): void {
  for (const edit of edits) {
    const fullPath = join(projectDir, edit.file);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, edit.content, 'utf-8');
  }
}

export class CodingAgentModule implements JarvisModule {
  name = 'coding-agent' as const;
  description = 'Autonomous coding agent that edits existing codebases — code, test, refactor, and fix bugs with an iterative build-fix loop';

  patterns: PatternDefinition[] = [
    {
      intent: 'code',
      patterns: [
        /^(?:autonomous(?:ly)?\s+)?code\s+(?:agent\s+)?(.+)/i,
        /^coding\s+agent\s+(.+)/i,
        // "create/add module ..." belongs to self-improve, not the coding agent.
        /^(?:add|implement|create)\s+(?!(?:a\s+)?module\b)(.+?)(?:\s+in\s+(.+))?$/i,
      ],
      extract: (_match, raw) => {
        const inMatch = raw.match(/\s+in\s+((?:~|\/)[^\s]+)\s*$/i);
        const task = inMatch ? raw.slice(0, inMatch.index).replace(/^(?:autonomous(?:ly)?\s+)?(?:code\s+(?:agent\s+)?|coding\s+agent\s+|(?:add|implement|create)\s+)/i, '') : _match[1].trim();
        return { task, directory: inMatch ? inMatch[1] : '' };
      },
    },
    {
      intent: 'test',
      patterns: [
        /^add\s+tests?\s+(?:to|for)\s+(.+)/i,
        /^(?:write|create)\s+tests?\s+(?:for|in)\s+(.+)/i,
        /^test\s+(.+)/i,
      ],
      extract: (match) => ({ directory: match[1].trim(), task: `Write comprehensive tests for the project` }),
    },
    {
      intent: 'refactor',
      patterns: [
        /^refactor\s+(.+)/i,
        /^clean\s+up\s+(.+)/i,
      ],
      extract: (match) => ({ directory: match[1].trim(), task: `Refactor and improve code quality` }),
    },
    {
      intent: 'fix-bugs',
      patterns: [
        /^fix[\s-]*bugs?\s+(?:in\s+)?(.+)/i,
        /^find\s+(?:and\s+)?fix\s+(?:bugs?\s+)?(?:in\s+)?(.+)/i,
        /^debug\s+project\s+(.+)/i,
      ],
      extract: (match) => ({ directory: match[1].trim(), task: `Find and fix bugs in the project` }),
    },
  ];

  async execute(command: ParsedCommand): Promise<CommandResult> {
    const task = command.args.task || `${command.action} the project`;
    const directory = command.args.directory || '';

    if (!directory) {
      return { success: false, message: 'Please specify a project directory. Example: "code agent add pagination in ~/projects/myapp"' };
    }

    const projectDir = resolvePath(directory);
    if (!existsSync(projectDir)) {
      return { success: false, message: `Directory not found: ${projectDir}` };
    }

    return this.runCodingLoop(projectDir, task, command.action);
  }

  private async runCodingLoop(projectDir: string, task: string, action: string): Promise<CommandResult> {
    const timestamp = Date.now();
    const branchName = `jarvis/coding-agent-${timestamp}`;

    // Create a branch
    process.stdout.write(`\n  [coding-agent] Working in: ${projectDir}\n`);
    const isGit = existsSync(join(projectDir, '.git'));
    if (isGit) {
      process.stdout.write(`  [coding-agent] Creating branch: ${branchName}\n`);
      const branchResult = runCommand(`git checkout -b ${branchName}`, projectDir);
      if (!branchResult.ok) {
        process.stdout.write(`  [coding-agent] Warning: could not create branch: ${branchResult.output.slice(0, 100)}\n`);
      }
    }

    // Step 1: Scan project
    process.stdout.write('  [coding-agent] Scanning project structure...\n');
    const fileList = scanProject(projectDir);
    const keyContents = readKeyFiles(projectDir, fileList);

    // Step 2: Plan changes via LLM
    process.stdout.write('  [coding-agent] Planning changes...\n');
    let planJson = '';
    const planRaw = await llmStreamChat(
      [{
        role: 'user',
        content: `Project directory: ${projectDir}\nTask: ${task}\nAction: ${action}\n\nProject files:\n${fileList}\n\nKey file contents:\n${keyContents}`,
      }],
      CODING_SYSTEM_PROMPT,
      (token) => { planJson += token; },
    );

    let plan: CodingPlan;
    try {
      plan = parsePlan(planRaw || planJson);
    } catch {
      return { success: false, message: 'Failed to parse coding plan from LLM. Try rephrasing your request.' };
    }

    if (!plan.edits || plan.edits.length === 0) {
      return { success: false, message: 'LLM returned no file edits. The task may be unclear.' };
    }

    // Step 3: Apply edits
    process.stdout.write(`  [coding-agent] Applying ${plan.edits.length} file edit(s)...\n`);
    try {
      applyEdits(projectDir, plan.edits);
    } catch (err: unknown) {
      return { success: false, message: `Failed to write files: ${(err as Error).message}` };
    }

    // Step 4: Iterative test-fix loop
    let testPassed = false;
    let lastError = '';
    let currentPlan = plan;

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration++) {
      const testCmd = currentPlan.test_command;
      if (!testCmd) {
        process.stdout.write('  [coding-agent] No test command specified, skipping validation.\n');
        testPassed = true;
        break;
      }

      process.stdout.write(`  [coding-agent] Iteration ${iteration}/${MAX_ITERATIONS}: running "${testCmd}"...\n`);
      const result = runCommand(testCmd, projectDir, 120_000);

      if (result.ok) {
        process.stdout.write('  [coding-agent] Tests/build passed!\n');
        testPassed = true;
        break;
      }

      lastError = result.output;
      process.stdout.write(`  [coding-agent] Failed: ${lastError.slice(0, 200)}\n`);

      if (iteration >= MAX_ITERATIONS) break;

      // Read current state of edited files for context
      const currentFiles = currentPlan.edits.map(e => {
        const fullPath = join(projectDir, e.file);
        try {
          return { file: e.file, content: readFileSync(fullPath, 'utf-8') };
        } catch {
          return { file: e.file, content: e.content };
        }
      });

      process.stdout.write('  [coding-agent] Sending errors to LLM for fix...\n');
      let fixJson = '';
      const fixRaw = await llmStreamChat(
        [{
          role: 'user',
          content: `Original task: ${task}\n\nCurrent files:\n${JSON.stringify(currentFiles, null, 2)}\n\nTest command: ${testCmd}\nError output:\n${lastError.slice(0, 3000)}\n\nFix the errors. Return the updated plan JSON.`,
        }],
        FIX_SYSTEM_PROMPT,
        (token) => { fixJson += token; },
      );

      try {
        const fixPlan = parsePlan(fixRaw || fixJson);
        applyEdits(projectDir, fixPlan.edits);
        currentPlan = {
          edits: fixPlan.edits,
          test_command: fixPlan.test_command || currentPlan.test_command,
          commit_message: fixPlan.commit_message || currentPlan.commit_message,
        };
      } catch {
        process.stdout.write('  [coding-agent] Could not parse fix from LLM, retrying...\n');
      }
    }

    // Step 5: Git commit on success
    const commitMessage = currentPlan.commit_message || `jarvis: ${task}`;
    if (isGit && testPassed) {
      process.stdout.write(`  [coding-agent] Committing: ${commitMessage}\n`);
      const commitResult = runCommand(`git add -A && git commit -m "${commitMessage.replace(/"/g, '\\"')}"`, projectDir);
      if (!commitResult.ok) {
        process.stdout.write(`  [coding-agent] Commit warning: ${commitResult.output.slice(0, 200)}\n`);
      }
    } else if (isGit && !testPassed) {
      // Stage but don't commit if tests failed
      runCommand('git add -A', projectDir);
      process.stdout.write('  [coding-agent] Changes staged but not committed due to test failures.\n');
    }

    const editedFiles = currentPlan.edits.map(e => e.file).join(', ');
    const statusMsg = testPassed
      ? `Task completed successfully. Edited: ${editedFiles}. ${isGit ? `Committed on branch ${branchName}.` : ''}`
      : `Task completed with errors. Edited: ${editedFiles}. Last error:\n${lastError.slice(0, 300)}`;

    return {
      success: testPassed,
      message: statusMsg,
      voiceMessage: testPassed
        ? `Coding task complete. I edited ${currentPlan.edits.length} file${currentPlan.edits.length > 1 ? 's' : ''} and all tests pass.`
        : `I made the code changes but there are still some test failures after ${MAX_ITERATIONS} attempts. Please review the changes.`,
      data: {
        projectDir,
        branch: isGit ? branchName : null,
        editedFiles: currentPlan.edits.map(e => e.file),
        testPassed,
      },
    };
  }

  getHelp(): string {
    return [
      '  Coding Agent -- autonomous code editing in existing projects',
      '    code agent <task> in <dir>     Autonomous coding task in a project',
      '    add tests to <dir>             Write and run tests',
      '    refactor <dir>                 Refactor code in a directory',
      '    fix bugs in <dir>              Find and fix bugs',
    ].join('\n');
  }
}
