import { describe, expect, it } from 'vitest';
import { leadOf } from './lead.js';

const body = (s: string) => leadOf({ body: s });

describe('leadOf (§3.1)', () => {
  it('is the summary when present, whatever the body', () => {
    expect(leadOf({ summary: 'Short version.', body: 'Long version.\n\nMore.' })).toEqual({ text: 'Short version.', source: 'summary' });
  });

  it('is the first paragraph, up to a blank line', () => {
    expect(body('Anna asks about the invoice.\nShe pays on time.\n\n## Proposed reply\n\n> Fine.')).toEqual({ text: 'Anna asks about the invoice.\nShe pays on time.', source: 'body' });
  });

  it('skips leading headings, thematic breaks and fences, mermaid included', () => {
    expect(body('## Context\n\nThe milestone slipped.').text).toBe('The milestone slipped.');
    expect(body('# Title\n## Sub\nRight under the heading.\n\nNext.').text).toBe('Right under the heading.');
    expect(body('```mermaid\npie title X\n  "a" : 1\n```\n\nAfter the chart.').text).toBe('After the chart.');
    expect(body('~~~~\n```\nstill code\n~~~~\n---\n\nAfter.').text).toBe('After.');
    expect(body('* * *\n\nAfter a break.').text).toBe('After a break.');
  });

  it('ends at the start of another block', () => {
    expect(body('Lead line.\n- item').text).toBe('Lead line.');
    expect(body('Lead line.\n> quote').text).toBe('Lead line.');
    expect(body('Lead line.\n| a | b |').text).toBe('Lead line.');
    expect(body('Lead line.\n```\ncode\n```').text).toBe('Lead line.');
    expect(body('Lead line.\n### Heading').text).toBe('Lead line.');
    expect(body('Lead line.\n2) second').text).toBe('Lead line.');
    expect(body('Lead line.\n#hashtag is text').text).toBe('Lead line.\n#hashtag is text');
  });

  it('starts at any other line, a list item included, and trims each line', () => {
    expect(body('- first item\n- second').text).toBe('- first item');
    expect(body('   indented  \n  continued  ').text).toBe('indented\ncontinued');
    expect(body('Line one\r\nline two\r\n\r\nNext').text).toBe('Line one\nline two');
  });

  it('is empty when there is no paragraph', () => {
    expect(body('')).toEqual({ text: '', source: 'body' });
    expect(body('## Only a heading\n\n```mermaid\nflowchart LR\n```').text).toBe('');
    expect(body('```\nunclosed fence\n\nstill inside').text).toBe('');
  });
});
