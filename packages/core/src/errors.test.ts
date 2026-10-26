import { describe, expect, it } from 'vitest';
import { ERROR_CODES, PbcpError } from './errors.js';

describe('PbcpError', () => {
  it('carries the RFC status for its code', () => {
    const e = new PbcpError('cross_namespace_supersede', 'nope');
    expect(e).toBeInstanceOf(Error);
    expect(e.status).toBe(403);
    expect(e.code).toBe('cross_namespace_supersede');
    expect(e.toJSON()).toEqual({ error: 'cross_namespace_supersede', message: 'nope' });
  });

  it('only uses the §7.4 refusal codes', () => {
    expect(new Set(Object.values(ERROR_CODES))).toEqual(new Set([400, 401, 403, 404, 409, 413, 429]));
  });
});
