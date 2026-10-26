import { CARD_LIMIT_BYTES, isId } from '@pbcp/core';
import { describe, expect, it } from 'vitest';
import { dateOf, isoWeek, namespaceOf, stripFrontMatter, toCard, unlink } from './note.js';

const cfg = { vault: 'my-vault', toPerson: 'morten' };

describe('isoWeek', () => {
  it.each([
    ['2026-10-26', '2026-W44'],
    ['2026-12-31', '2026-W53'],
    ['2027-01-01', '2026-W53'],
    ['2027-01-04', '2027-W01'],
    ['2021-01-03', '2020-W53'],
    ['2021-01-04', '2021-W01'],
    ['2024-12-30', '2025-W01'],
    ['2026-01-01', '2026-W01'],
  ])('%s is %s', (date, week) => expect(isoWeek(date)).toBe(week));
});

describe('unlink', () => {
  it('turns wiki-links and embeds into plain text', () => {
    expect(unlink('see [[Page]] and [[Page|the page]]')).toBe('see Page and the page');
    expect(unlink('[[Page#Heading]], [[Page#A#B]], [[#Local]]')).toBe('Page > Heading, Page > A > B, Local');
    expect(unlink('[[Page#^abc123]] and [[Page#^abc|alias]]')).toBe('Page and alias');
    expect(unlink('![[diagram.png]] ![[Note#Part|shown]]')).toBe('diagram.png shown');
    expect(unlink('[not](a link) [[a]][[b]]')).toBe('[not](a link) ab');
  });
});

describe('stripFrontMatter', () => {
  it('drops only a leading properties block', () => {
    expect(stripFrontMatter('---\ntags: [daily]\nmood: ok\n---\n# Today\n')).toBe('# Today\n');
    expect(stripFrontMatter('---\r\na: b\r\n---')).toBe('');
    expect(stripFrontMatter('# Today\n---\na: b\n---\n')).toBe('# Today\n---\na: b\n---\n');
  });
});

describe('dateOf', () => {
  it('accepts real YYYY-MM-DD.md names only', () => {
    expect(dateOf('2026-10-26.md')).toBe('2026-10-26');
    expect(dateOf('2028-02-29.md')).toBe('2028-02-29');
    for (const f of ['2026-02-30.md', '2026-13-01.md', '2026-10-26.txt', 'notes.md', 'x2026-10-26.md']) expect(dateOf(f)).toBeUndefined();
  });
});

describe('toCard', () => {
  it('maps a note to a log artifact in its ISO week', () => {
    const c = toCard('---\ntags: daily\n---\n# Monday\n\nMet [[Anna Berg|Anna]] about [[Invoices#September]].\n', '2026-10-26', cfg);
    expect(isId(c.id)).toBe(true);
    expect(c).toMatchObject({
      id: 'obsidian:my-vault:2026-10-26',
      protocol: 'pbcp/1',
      producer: 'obsidian',
      kind: 'artifact',
      to_person: 'morten',
      urgency: 'log',
      thread: '2026-W44',
      title: 'Daily note 2026-10-26',
      body: '# Monday\n\nMet Anna about Invoices > September.',
    });
    expect('actions' in c).toBe(false);
  });

  it('truncates an over-long note to fit the card limit, with a note', () => {
    const c = toCard(`start\n${'é"\n'.repeat(40_000)}end`, '2026-10-26', cfg);
    expect(Buffer.byteLength(JSON.stringify(c))).toBeLessThanOrEqual(CARD_LIMIT_BYTES);
    expect(Buffer.byteLength(JSON.stringify(c))).toBeGreaterThan(CARD_LIMIT_BYTES * 0.9);
    expect(c.body.startsWith('start\n')).toBe(true);
    expect(c.body).toMatch(/_Truncated: .*_$/);
    expect(toCard('short', '2026-10-26', cfg).body).toBe('short');
  });
});

describe('namespaceOf', () => {
  it('slugs a vault folder name', () => {
    expect(namespaceOf('My Vault (2026)')).toBe('my-vault-2026');
    expect(namespaceOf('___')).toBe('vault');
  });
});
