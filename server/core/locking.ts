/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'fs';
import logger from './logger';

/**
 * Checks if a file is physically read-only.
 */
export function isFileReadOnly(filePath: string): boolean {
  try {
    const stats = fs.statSync(filePath);
    // On UNIX/Windows, we check if the user-write bit is set.
    // 0o200 is S_IWUSR (user write permission)
    return (stats.mode & 0o200) === 0;
  } catch (error) {
    logger.error(`Failed to inspect file permissions for ${filePath}:`, error);
    return false;
  }
}

/**
 * Sets a file's physical permissions to Read-Only.
 */
export function lockFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    // Set to read-only. 0o444 allows read for everyone, no write.
    // 0o400 allows owner-only read, no write. Let's use 0o444 for safety.
    fs.chmodSync(filePath, 0o444);
    logger.info(`OS write-lock applied successfully: ${filePath} is now Read-Only.`);
  } catch (error) {
    logger.error(`Failed to lock file ${filePath}:`, error);
  }
}

/**
 * Elevates a file's physical permissions to Read-Write.
 */
export function unlockFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    // Restore write permissions. 0o644 allows owner write, read for everyone.
    fs.chmodSync(filePath, 0o644);
    logger.info(`OS write-lock lifted successfully: ${filePath} is now writeable.`);
  } catch (error) {
    logger.error(`Failed to unlock file ${filePath}:`, error);
  }
}
