import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { lockFile, unlockFile, isFileReadOnly } from '../../server/core/locking';

const TEST_DIR = path.join(process.cwd(), '__test_locking__');
const TEST_FILE = path.join(TEST_DIR, 'test_file.txt');

function cleanup() {
  if (fs.existsSync(TEST_FILE)) {
    fs.chmodSync(TEST_FILE, 0o644);
    fs.unlinkSync(TEST_FILE);
  }
  if (fs.existsSync(TEST_DIR)) {
    fs.rmdirSync(TEST_DIR);
  }
}

describe('locking module', () => {
  beforeEach(() => {
    if (!fs.existsSync(TEST_DIR)) {
      fs.mkdirSync(TEST_DIR);
    }
    fs.writeFileSync(TEST_FILE, 'test content', 'utf8');
    fs.chmodSync(TEST_FILE, 0o644);
  });

  afterEach(() => {
    cleanup();
  });

  it('isFileReadOnly returns false for writable file', () => {
    expect(isFileReadOnly(TEST_FILE)).toBe(false);
  });

  it('lockFile makes file read-only', () => {
    lockFile(TEST_FILE);
    expect(isFileReadOnly(TEST_FILE)).toBe(true);
  });

  it('unlockFile restores write permissions', () => {
    lockFile(TEST_FILE);
    expect(isFileReadOnly(TEST_FILE)).toBe(true);

    unlockFile(TEST_FILE);
    expect(isFileReadOnly(TEST_FILE)).toBe(false);
  });

  it('lockFile is silent on non-existent file', () => {
    expect(() => lockFile(path.join(TEST_DIR, 'nonexistent.txt'))).not.toThrow();
  });

  it('unlockFile is silent on non-existent file', () => {
    expect(() => unlockFile(path.join(TEST_DIR, 'nonexistent.txt'))).not.toThrow();
  });

  it('isFileReadOnly returns false for non-existent file', () => {
    expect(isFileReadOnly(path.join(TEST_DIR, 'nonexistent.txt'))).toBe(false);
  });
});
