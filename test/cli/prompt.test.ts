import { describe, it, expect } from 'vitest';
import { PassThrough, type Readable, type Writable } from 'node:stream';
import { promptPassword, PromptCancelled } from '../../src/cli/prompt.js';

/**
 * Create a fake TTY readable stream. PassThrough with isTTY=true and a
 * setRawMode stub so promptPassword takes the raw-mode branch.
 */
function makeFakeTTY(): { input: Readable & { isTTY: boolean; setRawMode: (raw: boolean) => void }; output: Writable & { isTTY: boolean }; written: string[] } {
  const input = new PassThrough() as unknown as Readable & {
    isTTY: boolean;
    setRawMode: (raw: boolean) => void;
    _rawMode: boolean;
  };
  input.isTTY = true;
  input._rawMode = false;
  input.setRawMode = (raw: boolean) => {
    input._rawMode = raw;
  };

  const output = new PassThrough() as unknown as Writable & { isTTY: boolean };
  output.isTTY = true;

  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf-8')));

  return { input, output, written };
}

function makeNonTTY(): { input: Readable; output: Writable; written: string[] } {
  const input = new PassThrough() as unknown as Readable;
  const output = new PassThrough() as unknown as Writable;
  const written: string[] = [];
  output.on('data', (chunk: Buffer) => written.push(chunk.toString('utf-8')));
  return { input, output, written };
}

describe('promptPassword — TTY mode', () => {
  it('resolves with typed characters when Enter is pressed', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: 'pass: ', input: input as any, output: output as any });

    // Simulate user typing "abc\n"
    input.write(Buffer.from('abc\n'));

    expect(await result).toBe('abc');
  });

  it('masks each character with *', async () => {
    const { input, output, written } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: 'pass: ', input: input as any, output: output as any });

    input.write(Buffer.from('abc\n'));
    await result;

    const combined = written.join('');
    // Prompt + 3 asterisks + newline
    expect(combined).toContain('pass: ');
    expect(combined).toContain('***');
    // Actual characters should NOT leak to output
    expect(combined).not.toContain('abc');
  });

  it('handles backspace — removes last char from buffer and erases *', async () => {
    const { input, output, written } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    // Type "abx", backspace, "c", Enter → "abc"
    input.write(Buffer.from('abx'));
    input.write(Buffer.from([0x7f])); // DEL
    input.write(Buffer.from('c\n'));

    expect(await result).toBe('abc');
    // Output should contain the erase sequence
    expect(written.join('')).toContain('\b \b');
  });

  it('handles classic backspace 0x08 in addition to DEL 0x7f', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from('ab'));
    input.write(Buffer.from([0x08])); // classic BS
    input.write(Buffer.from('c\n'));

    expect(await result).toBe('ac');
  });

  it('backspace on empty buffer is a no-op', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from([0x7f, 0x7f])); // two backspaces on empty
    input.write(Buffer.from('x\n'));

    expect(await result).toBe('x');
  });

  it('Ctrl+C rejects with PromptCancelled', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from('secret'));
    input.write(Buffer.from([0x03])); // Ctrl+C

    await expect(result).rejects.toThrow(PromptCancelled);
  });

  it('Ctrl+D rejects with PromptCancelled (EOF in raw mode)', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from('partial'));
    input.write(Buffer.from([0x04])); // Ctrl+D

    await expect(result).rejects.toThrow(PromptCancelled);
  });

  it('Ctrl+C restores TTY raw mode', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from([0x03]));
    await expect(result).rejects.toThrow(PromptCancelled);

    // After cancel, raw mode should be off
    expect((input as unknown as { _rawMode: boolean })._rawMode).toBe(false);
  });

  it('ignores other control characters silently', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    // Send Ctrl+A (0x01), Ctrl+Z (0x1a), then real input
    input.write(Buffer.from([0x01, 0x1a]));
    input.write(Buffer.from('a\n'));

    expect(await result).toBe('a');
  });

  it('handles CR (0x0d) as submit in addition to LF (0x0a)', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from('pw'));
    input.write(Buffer.from([0x0d])); // CR

    expect(await result).toBe('pw');
  });

  it('restores raw mode on successful submit', async () => {
    const { input, output } = makeFakeTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: '', input: input as any, output: output as any });

    input.write(Buffer.from('x\n'));
    await result;

    expect((input as unknown as { _rawMode: boolean })._rawMode).toBe(false);
  });
});

describe('promptPassword — non-TTY fallback', () => {
  it('falls back to readline when stdin is not a TTY', async () => {
    const { input, output } = makeNonTTY();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = promptPassword({ message: 'pass: ', input: input as any, output: output as any });

    input.write('piped-password\n');
    input.end();

    expect(await result).toBe('piped-password');
  });
});

describe('PromptCancelled', () => {
  it('has the correct name', () => {
    const err = new PromptCancelled();
    expect(err.name).toBe('PromptCancelled');
  });

  it('is an Error subclass', () => {
    const err = new PromptCancelled();
    expect(err).toBeInstanceOf(Error);
  });
});
