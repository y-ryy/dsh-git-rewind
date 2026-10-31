/** Shared wire constants for both halves of dsh-git-rewind. */
export const PLUGIN_ID = 'dsh-git-rewind'
export const SOURCE_KIND = 'dsh-git-rewind'
export const PROJECTION_KEY = 'gitRewind'
export const ROUTE_PREFIX = '/api/plugins/dsh-git-rewind'
export const MAX_ANCHORS = 200
export const MAX_PREVIEW_CHARS = 160
export const DEFAULT_EXCLUDES = [
  '.git',
  'node_modules',
  '.dsh',
  'dist',
  'build',
  'coverage',
  '.next',
  '__pycache__',
  '.venv',
  'venv',
]
