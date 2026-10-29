import { describe, expect, test } from 'bun:test';
import { fillSubject, mailBody, mailtoHref } from './mailto';

describe('mailto hand-off', () => {
  test('spaces are %20 and line breaks CRLF, so mail programs show the text as typed', () => {
    const href = mailtoHref('kontakt@example.test', 'Demo anfragen: Büro Nord', 'Zeile eins\nZeile zwei');
    expect(href).toBe(
      'mailto:kontakt@example.test?subject=Demo%20anfragen%3A%20B%C3%BCro%20Nord&body=Zeile%20eins%0D%0AZeile%20zwei',
    );
    expect(href).not.toContain('+');
  });

  test('characters that would end the query are encoded', () => {
    const href = mailtoHref('a@example.test', 'A & B ? C', 'x=1&body=evil#frag');
    const query = new URL(href).search;
    const params = new URLSearchParams(query);
    expect(params.get('subject')).toBe('A & B ? C');
    expect(params.get('body')).toBe('x=1&body=evil#frag');
  });

  test('the body lists filled fields as "Label: value" and puts the message after a blank line', () => {
    const body = mailBody(
      [
        { label: 'Name', value: ' Ada Muster ' },
        { label: 'Büro', value: '' },
        { label: 'E-Mail', value: 'ada@example.test' },
      ],
      'Wir planen ein Wohnprojekt.\n',
    );
    expect(body).toBe('Name: Ada Muster\nE-Mail: ada@example.test\n\nWir planen ein Wohnprojekt.');
  });

  test('a body without a message has no trailing blank line', () => {
    expect(mailBody([{ label: 'Land', value: 'Österreich' }])).toBe('Land: Österreich');
  });

  test('the subject takes form values and drops tokens that stayed empty', () => {
    expect(fillSubject('Demo-Anfrage: {office}', { office: 'Büro Nord' })).toBe('Demo-Anfrage: Büro Nord');
    expect(fillSubject('Anfrage von {name} {office}', { name: 'Ada', office: '' })).toBe('Anfrage von Ada');
  });
});
