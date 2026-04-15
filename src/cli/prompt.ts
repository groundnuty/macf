/**
 * Terminal prompt helpers.
 *
 * `promptPassword` reads a passphrase from stdin with each character echoed
 * as `*` so the user gets visual feedback for length and typos but the
 * real text never reaches the terminal scrollback or screen recordings.
 *
 * Uses raw mode (byte-by-byte) when stdin is a TTY. Falls back to plain
 * readline (unmasked) when stdin is piped — masking piped input is both
 * impossible and unnecessary since there's no observer.
 */
import { createInterface } from 'node:readline';

export class PromptCancelled extends Error {
  constructor() {
    super('Prompt cancelled by user (Ctrl+C)');
    this.name = 'PromptCancelled';
  }
}

/**
 * Check if a readable stream is a TTY that supports raw mode.
 * Typed loosely because Node's type def for Readable doesn't include TTY fields.
 */
function isRawModeTTY(stream: NodeJS.ReadStream): boolean {
  return Boolean(stream.isTTY) && typeof stream.setRawMode === 'function';
}

interface PromptOptions {
  readonly message: string;
  readonly input?: NodeJS.ReadStream;
  readonly output?: NodeJS.WriteStream;
}

/**
 * Prompt the user for a password, echoing '*' per character.
 *
 * Rejects with PromptCancelled on Ctrl+C. Restores TTY state on success,
 * cancel, and error paths.
 */
export function promptPassword(options: PromptOptions): Promise<string> {
  const input = options.input ?? process.stdin;
  const output = options.output ?? process.stderr;

  // Non-TTY (piped/redirected stdin): fall back to plain readline.
  // Masking is meaningless when there's no terminal observer.
  if (!isRawModeTTY(input)) {
    return new Promise((resolve) => {
      const rl = createInterface({ input, output });
      rl.question(options.message, (answer) => {
        rl.close();
        resolve(answer);
      });
    });
  }

  return new Promise((resolve, reject) => {
    output.write(options.message);

    let settled = false;
    let buffer = '';

    const finish = (resultOrErr: string | Error): void => {
      if (settled) return;
      settled = true;
      input.setRawMode(false);
      input.pause();
      input.removeListener('data', onData);
      if (resultOrErr instanceof Error) {
        reject(resultOrErr);
      } else {
        resolve(resultOrErr);
      }
    };

    const onData = (chunk: Buffer): void => {
      const bytes = chunk;
      for (let i = 0; i < bytes.length; i++) {
        const b = bytes[i]!;

        // Enter (LF or CR) → submit
        if (b === 0x0a || b === 0x0d) {
          output.write('\n');
          finish(buffer);
          return;
        }

        // Ctrl+C (0x03) → cancel
        if (b === 0x03) {
          output.write('^C\n');
          finish(new PromptCancelled());
          return;
        }

        // Ctrl+D (0x04) → treat as cancel (EOF in raw mode). Without this,
        // an empty-buffer EOF would leak through as a silent empty password.
        if (b === 0x04) {
          output.write('\n');
          finish(new PromptCancelled());
          return;
        }

        // Backspace (0x7f DEL on most terminals, 0x08 legacy)
        if (b === 0x7f || b === 0x08) {
          if (buffer.length > 0) {
            buffer = buffer.slice(0, -1);
            // Erase one asterisk: backspace, space, backspace
            output.write('\b \b');
          }
          continue;
        }

        // Other control chars — ignore
        if (b < 0x20) continue;

        // Printable character — append and echo '*'
        buffer += String.fromCharCode(b);
        output.write('*');
      }
    };

    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
