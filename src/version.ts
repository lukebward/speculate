import { findSpeculatePackage } from './packageResources.js';

const located = findSpeculatePackage(
  import.meta.url,
  ({ manifest }) => typeof manifest.version === 'string',
);
const packageVersion = located?.manifest.version;

export const VERSION = typeof packageVersion === 'string' ? packageVersion : '0.0.0-unknown';
