'use babel';

import { COMMON_IGNORE_DIRS } from './commonIgnoreDirs';

export const FILE_STATUS = {
  created: 'created',
  modified: 'modified',
  deleted: 'deleted',
  same: 'same',
};

export const HASH_ALGORITHM = 'sha256';
export const ENCODE_TYPE = 'hex';
export const FILE_FORMAT = 'utf-8';
export const GIT_FILENAME = '.git';
export const GITIGNORE_FILENAME = '.gitignore';
export const DCIGNORE_FILENAME = '.dcignore';
export const EXCLUDED_NAMES = [
  'node_modules',
  '.git',
  '/.git',
  '.git/',
  '.idea',
  '/.idea',
  '.idea/',
  GITIGNORE_FILENAME,
  DCIGNORE_FILENAME,
  ...COMMON_IGNORE_DIRS,
];