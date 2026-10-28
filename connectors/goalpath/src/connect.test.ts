import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PLACEHOLDERS, setupOf } from '../../../scripts/setup-section.ts';
import { connect } from './connect.js';

const values = { api: 'https://head.example/api', owner: 'anna', token: "pbcp_it's" };

describe('connect', () => {
  it('is the README Setup section, with placeholders (scripts/readme-setup.ts writes it)', () => {
    expect(setupOf(readFileSync(new URL('../README.md', import.meta.url), 'utf8'))).toBe(connect(PLACEHOLDERS).trim());
  });

  it('fills in the three values', () => {
    const md = connect(values);
    expect(md).not.toMatch(/<head url>|<owner>|<token>/);
    expect(md).toContain(`export PBCP_HEAD_URL='https://head.example/api' PBCP_TO_PERSON='anna' PBCP_TOKEN='pbcp_it'\\''s'`);
    expect(md).toContain('The token is bound to the root `goalpath`');
  });
});
