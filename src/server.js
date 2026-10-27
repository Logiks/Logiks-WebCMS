// The process entry. It only runs the update guard (built-ins only) and then loads the app, so a broken update can be undone
// before any of the broken code is even parsed (D-127). The app itself starts in main.js.
import { fileURLToPath } from 'node:url';
import { runUpdateGuard } from './core/update-guard.js';

runUpdateGuard(fileURLToPath(new URL('..', import.meta.url)));
await import('./main.js');
