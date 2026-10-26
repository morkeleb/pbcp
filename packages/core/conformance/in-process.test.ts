import { inProcessHead } from './in-process/head.js';
import { referenceRenderer } from './in-process/render.js';
import { conformanceSuite } from './suite.js';

conformanceSuite({ head: () => inProcessHead(), render: () => referenceRenderer(), extensions: ['orders'] });
