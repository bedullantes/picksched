/**
 * Fails if the repository contains anything that looks like a real secret:
 * provider API keys, private keys, database URLs with passwords, or .env
 * files other than the committed development defaults and templates.
 *
 *   npm run check:secrets              tracked files
 *   npm run check:secrets -- --history every commit in the git history
 *
 * Simulator placeholders used in tests and development (sk_test_local,
 * SG.local, ...) are deliberately too short to match.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

export interface Finding { file: string; line: number; rule: string; excerpt: string }

const RULES: [string, RegExp][] = [
  ['PayMongo secret/public key', /\b[sp]k_(live|test)_[A-Za-z0-9]{16,}/],
  ['PayMongo webhook secret', /\bwhsk_[A-Za-z0-9]{16,}/],
  ['SendGrid API key', /\bSG\.[\w-]{16,}\.[\w-]{16,}/],
  ['Twilio Account SID / API key', /\b(AC|SK)[0-9a-f]{32}\b/],
  ['AWS access key', /\b(AKIA|ASIA)[0-9A-Z]{16}\b/],
  ['Private key', /-----BEGIN (RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/],
  ['Database URL with password', /\bpostgres(ql)?:\/\/[^:\s/@'"`]+:(?!PASSWORD@|\*\*\*@|\$\{|<)[^@\s'"`]{3,}@/i],
  ['Secret assignment', /^\s*(SESSION_SECRET|[A-Z_]*(AUTH_TOKEN|API_KEY|SECRET_KEY|WEBHOOK_SECRET))\s*=\s*(?!<|$|sk_test_local\b|whsk_local\b|SG\.local\b|local\b)\S{16,}/],
];

/** .env files allowed in the repository (no real values). */
const ALLOWED_ENV_FILE = /(^|\/)\.env\.(development|[\w-]+\.example)$/;

export function scanText(file: string, text: string): Finding[] {
  const findings: Finding[] = [];
  text.split('\n').forEach((line, i) => {
    for (const [rule, re] of RULES) {
      if (re.test(line)) findings.push({ file, line: i + 1, rule, excerpt: line.trim().slice(0, 120) });
    }
  });
  return findings;
}

export function scanRepository(root: string): Finding[] {
  const files = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  const findings: Finding[] = [];
  for (const file of files) {
    if (/(^|\/)\.env(\.|$)/.test(file) && !ALLOWED_ENV_FILE.test(file)) {
      findings.push({ file, line: 0, rule: 'Committed .env file', excerpt: file });
    }
    if (/\.(png|jpe?g|gif|ico|woff2?|zip|lock)$/.test(file) || file.endsWith('package-lock.json')) continue;
    let text: string;
    try {
      text = readFileSync(path.join(root, file), 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    findings.push(...scanText(file, text));
  }
  return findings;
}

export function scanHistory(root: string): Finding[] {
  const log = execFileSync('git', ['log', '-p', '--all', '--no-color', '--format=commit %H'],
    { cwd: root, encoding: 'utf8', maxBuffer: 1024 * 1024 * 512 });
  let commit = '';
  let file = '';
  const findings: Finding[] = [];
  for (const line of log.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7, 15);
    else if (line.startsWith('+++ b/')) file = line.slice(6);
    else if (line.startsWith('+') && !line.startsWith('+++') && !file.endsWith('package-lock.json')) {
      for (const f of scanText(`${commit}:${file}`, line.slice(1))) findings.push(f);
    }
  }
  return findings;
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const history = process.argv.includes('--history');
  const findings = history ? scanHistory(root) : scanRepository(root);
  if (findings.length) {
    console.error(`Possible secrets found (${findings.length}):`);
    for (const f of findings) console.error(`  ${f.file}${f.line ? `:${f.line}` : ''}  [${f.rule}]  ${f.excerpt}`);
    console.error('\nMove them to the environment / secret manager (see docs/deployment.md) and rotate any real key that was committed.');
    process.exit(1);
  }
  console.log(`No secrets found in ${history ? 'the git history' : 'tracked files'}.`);
}
