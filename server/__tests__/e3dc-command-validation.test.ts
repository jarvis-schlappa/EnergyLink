import { describe, it, expect } from 'vitest';
import { validateE3dcCommand } from '../e3dc-client';

describe('validateE3dcCommand', () => {
  // Valid commands
  it('should accept -a (Automatik)', () => {
    expect(validateE3dcCommand('-a')).toEqual(['-a']);
  });

  it('should accept -d with number', () => {
    expect(validateE3dcCommand('-d 1')).toEqual(['-d', '1']);
  });

  it('should accept -c with number', () => {
    expect(validateE3dcCommand('-c 2500')).toEqual(['-c', '2500']);
  });

  it('should accept -e with number', () => {
    expect(validateE3dcCommand('-e 6000')).toEqual(['-e', '6000']);
  });

  it('should accept combined flags', () => {
    expect(validateE3dcCommand('-d 1 -c 2500 -e 6000')).toEqual(['-d', '1', '-c', '2500', '-e', '6000']);
  });

  it('should accept -r with tag name', () => {
    expect(validateE3dcCommand('-r EMS_BAT_SOC -q')).toEqual(['-r', 'EMS_BAT_SOC', '-q']);
  });

  it('should accept -H with period', () => {
    expect(validateE3dcCommand('-H day')).toEqual(['-H', 'day']);
  });

  it('should accept -H with -D date', () => {
    expect(validateE3dcCommand('-H day -D 2026-02-09')).toEqual(['-H', 'day', '-D', '2026-02-09']);
  });

  it('should accept -l without argument', () => {
    expect(validateE3dcCommand('-l')).toEqual(['-l']);
  });

  it('should accept -l with category number', () => {
    expect(validateE3dcCommand('-l 1')).toEqual(['-l', '1']);
  });

  it('should accept -m with module number', () => {
    expect(validateE3dcCommand('-m 0')).toEqual(['-m', '0']);
  });

  it('should accept -s with subcommand', () => {
    expect(validateE3dcCommand('-s discharge 0')).toEqual(['-s', 'discharge', '0']);
  });

  it('should strip e3dcset prefix', () => {
    expect(validateE3dcCommand('e3dcset -a')).toEqual(['-a']);
  });

  // Command injection attempts
  it('should reject shell metacharacters (semicolon)', () => {
    expect(() => validateE3dcCommand('-r foo; rm -rf /')).toThrow();
  });

  it('should reject pipe injection', () => {
    expect(() => validateE3dcCommand('-r test | cat /etc/passwd')).toThrow();
  });

  it('should reject backtick injection', () => {
    expect(() => validateE3dcCommand('-r `whoami`')).toThrow();
  });

  it('should reject $() injection', () => {
    expect(() => validateE3dcCommand('-r $(whoami)')).toThrow();
  });

  it('should reject unknown flags', () => {
    expect(() => validateE3dcCommand('-x')).toThrow('Unbekannter Parameter');
  });

  it('should reject arbitrary commands', () => {
    expect(() => validateE3dcCommand('cat /etc/passwd')).toThrow('Unbekannter Parameter');
  });

  it('should reject empty command', () => {
    expect(() => validateE3dcCommand('')).toThrow('Befehl ist leer');
  });

  it('should reject -d without number', () => {
    expect(() => validateE3dcCommand('-d abc')).toThrow();
  });

  it('should reject string values with shell chars', () => {
    expect(() => validateE3dcCommand('-r "test;whoami"')).toThrow();
  });

  it('should reject && injection', () => {
    expect(() => validateE3dcCommand('-a && rm -rf /')).toThrow();
  });
});
