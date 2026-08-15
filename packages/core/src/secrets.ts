/**
 * Secret write-gate — PKR_SPEC.md §10 / ARCHITECTURE.md §6, §12.5.
 *
 * Runs on every piece of content before it is written to
 * `.projectknowledge/`. This is a defense-in-depth pattern/entropy scan, not
 * a guarantee — it defaults to over-redaction rather than permissiveness
 * (ARCHITECTURE.md §12.5). It is a write-gate, not a post-hoc lint: callers
 * are expected to run content through `redactSecrets` before it reaches disk.
 */

interface SecretPattern {
  reason: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { reason: "AWS access key", pattern: /AKIA[0-9A-Z]{16}/g },
  { reason: "private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { reason: "GitHub token", pattern: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { reason: "GitLab token", pattern: /glpat-[A-Za-z0-9_-]{20,}/g },
  { reason: "Stripe secret key", pattern: /sk_(live|test)_[A-Za-z0-9]{16,}/g },
  { reason: "Slack token", pattern: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { reason: "Google API key", pattern: /AIza[0-9A-Za-z_-]{35}/g },
  { reason: "generic bearer/JWT", pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    reason: "assigned high-entropy secret-shaped value",
    pattern: /\b(?:secret|token|api[_-]?key|password|passwd|pwd)\s*[:=]\s*["']?([A-Za-z0-9+/=_-]{16,})["']?/gi,
  },
];

export interface SecretMatch {
  reason: string;
  index: number;
}

export function scanForSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { reason, pattern } of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = pattern.exec(text)) !== null) {
      matches.push({ reason, index: m.index });
      if (m[0].length === 0) pattern.lastIndex++; // guard against zero-length infinite loop
    }
  }
  return matches;
}

export interface RedactionResult {
  text: string;
  redactions: SecretMatch[];
}

/** Replaces every matched secret with a fixed-width placeholder — never the value, never its length. */
export function redactSecrets(text: string): RedactionResult {
  let result = text;
  const redactions = scanForSecrets(text);
  for (const { reason, pattern } of SECRET_PATTERNS) {
    result = result.replace(pattern, `[REDACTED:${reason}]`);
  }
  return { text: result, redactions };
}
