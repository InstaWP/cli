import chalk from 'chalk';
import ora, { Ora } from 'ora';
import Table from 'cli-table3';

let jsonMode = false;

export function setJsonMode(enabled: boolean): void {
  jsonMode = enabled;
}

export function isJsonMode(): boolean {
  return jsonMode;
}

export function success(msg: string, data?: any): void {
  if (jsonMode) {
    console.log(JSON.stringify({ success: true, message: msg, ...(data !== undefined ? { data } : {}) }));
  } else {
    console.log(chalk.green('\u2713') + ' ' + msg);
    if (data && typeof data === 'object') {
      for (const [key, value] of Object.entries(data)) {
        console.log(`  ${chalk.dim(key + ':')} ${value}`);
      }
    }
  }
}

export function error(msg: string, details?: any): void {
  if (jsonMode) {
    console.error(JSON.stringify({ success: false, error: msg, ...(details !== undefined ? { details } : {}) }));
  } else {
    console.error(chalk.red('\u2717') + ' ' + msg);
    if (details) {
      console.error(chalk.dim(typeof details === 'string' ? details : JSON.stringify(details, null, 2)));
    }
  }
}

export function table(headers: string[], rows: Record<string, any>[]): void {
  if (jsonMode) {
    console.log(JSON.stringify(rows));
    return;
  }

  const t = new Table({
    head: headers.map(h => chalk.cyan(h)),
    style: { head: [], border: [] },
  });

  for (const row of rows) {
    t.push(headers.map(h => {
      const key = h.toLowerCase().replace(/\s+/g, '_');
      return String(row[key] ?? row[h] ?? '');
    }));
  }

  console.log(t.toString());
}

/** Truly silent: machine output (--json) or an explicit quiet request. */
function spinnerSilent(): boolean {
  return jsonMode || !!process.env.INSTAWP_QUIET;
}

export function spinner(text: string): Ora | { text: string; start: () => any; succeed: (t?: string) => void; fail: (t?: string) => void; stop: () => void } {
  if (spinnerSilent()) {
    return { text: '', start() { return this; }, succeed() {}, fail() {}, stop() {} };
  }

  // Animated spinner only on an interactive TTY (and when colors aren't disabled).
  if (process.stdout.isTTY && !process.env.CI && !process.env.NO_COLOR) {
    return ora(text);
  }

  // Non-interactive (pipe / CI / redirected / NO_COLOR): no animation, but emit
  // one-line phase markers to STDERR so long operations show a heartbeat instead
  // of going silent (e.g. a 144s db push looked hung). stderr keeps stdout/the
  // final summary clean for capture. ora itself writes to stderr, so this matches.
  return {
    text,
    start() { console.error(chalk.cyan('→') + ' ' + this.text); return this; },
    succeed(t?: string) { console.error(chalk.green('✓') + ' ' + (t || this.text)); },
    fail(t?: string) { console.error(chalk.red('✗') + ' ' + (t || this.text)); },
    stop() {},
  };
}

export function info(msg: string): void {
  if (!jsonMode) {
    console.log(chalk.blue('\u2139') + ' ' + msg);
  }
}
