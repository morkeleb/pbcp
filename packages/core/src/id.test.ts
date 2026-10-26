import { describe, expect, it } from 'vitest';
import { decodeUpstream, encodeUpstream, inRoot, isIntent, parseId, sameNamespace } from './id.js';

describe('parseId', () => {
  it('parses the RFC §5 examples', () => {
    expect(parseId('hermes:gmail:19a4f2e7c3b1')).toEqual({ producer: 'hermes', namespace: 'gmail', upstream: '19a4f2e7c3b1' });
    expect(parseId('goalpath:item:4421:ship-approval')).toEqual({
      producer: 'goalpath', namespace: 'item', upstream: '4421', intent: 'ship-approval',
    });
    expect(parseId('head:daily:2026-10-07')).toEqual({ producer: 'head', namespace: 'daily', upstream: '2026-10-07' });
    expect(parseId('head:order:01J9Q3K7X2')).toEqual({ producer: 'head', namespace: 'order', upstream: '01J9Q3K7X2' });
  });

  it('allows _ and . in upstream-id only', () => {
    expect(parseId('mail:imap:a_b.c')).not.toBeNull();
    expect(parseId('mail_x:imap:a')).toBeNull();
    expect(parseId('mail:im.ap:a')).toBeNull();
    expect(parseId('mail:imap:a:in_tent')).toBeNull();
  });

  it('rejects wrong segment counts, empty segments and non-ASCII', () => {
    for (const bad of ['', 'a', 'a:b', 'a:b:c:d:e', ':b:c', 'a::c', 'a:b:', 'a:b:c:', 'ä:b:c', 'a:b:c d', 'a:b:<c@d>', 'a:b:%', 'a:b:%4', 'a:b:%G1', 'a%41:b:c', 'a:b%41:c', 'a:b:c:in%41']) {
      expect(parseId(bad), bad).toBeNull();
    }
  });

  it('is case-sensitive and preserves case', () => {
    expect(parseId('Hermes:Gmail:X')?.producer).toBe('Hermes');
  });
});

describe('sameNamespace', () => {
  it('follows the §6 example', () => {
    expect(sameNamespace('goalpath:item:4421', 'goalpath:item:4421:revised')).toBe(true);
    expect(sameNamespace('goalpath:item:4421', 'goalpath:item:9999')).toBe(true);
    expect(sameNamespace('goalpath:item:4421', 'goalpath:milestone:88')).toBe(false);
    expect(sameNamespace('goalpath:item:4421', 'hermes:item:4421')).toBe(false);
  });
  it('is false for malformed ids', () => {
    expect(sameNamespace('goalpath:item', 'goalpath:item:1')).toBe(false);
  });
});

describe('inRoot', () => {
  it('matches the producer segment exactly', () => {
    expect(inRoot('hermes:gmail:19a4f2e7c3b1', 'hermes')).toBe(true);
    expect(inRoot('hermes:gmail:19a4f2e7c3b1', 'herm')).toBe(false);
    expect(inRoot('hermes-2:gmail:1', 'hermes')).toBe(false);
    expect(inRoot('not-an-id', 'not-an-id')).toBe(false);
  });
});

describe('isIntent', () => {
  it('accepts choice ids from §4.4', () => {
    expect(isIntent('ship-friday')).toBe(true);
    expect(isIntent('ship friday')).toBe(false);
  });
});

describe('percent-encoded upstream-id (§5)', () => {
  it('accepts %XX octets in upstream-id only', () => {
    expect(parseId('mail:acme:%3Ca%2Bb%40host%3E')).toEqual({ producer: 'mail', namespace: 'acme', upstream: '%3Ca%2Bb%40host%3E' });
    expect(parseId('mail:acme:x%2fy')?.upstream).toBe('x%2fy');
  });

  it('encodes any key into the grammar and back', () => {
    for (const key of ['<a+b@host>', 'plain-key_1.2', 'a/b c', 'é中', '%', ':::']) {
      const up = encodeUpstream(key);
      expect(parseId(`mail:acme:${up}`), key).not.toBeNull();
      expect(decodeUpstream(up)).toBe(key);
    }
    expect(encodeUpstream('<a+b@host>')).toBe('%3Ca%2Bb%40host%3E');
    expect(encodeUpstream('plain-key_1.2')).toBe('plain-key_1.2');
  });

  it('treats differently-cased escapes as different ids (no normalisation)', () => {
    expect(sameNamespace('mail:acme:x%2F', 'mail:acme:x%2f')).toBe(true);
    expect(parseId('mail:acme:x%2F')?.upstream).not.toBe(parseId('mail:acme:x%2f')?.upstream);
  });
});
