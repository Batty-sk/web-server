const ENTITIES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export const escapeHtml = (value: string): string => value.replace(/[&<>"']/g, (c) => ENTITIES[c] ?? c);

/** Tagged template that escapes every interpolation unless it is already marked safe with `raw`. */
export class SafeHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (value: string) => new SafeHtml(value);

type Part = string | number | SafeHtml | null | undefined | false | Part[];

const stringify = (part: Part): string => {
  if (part === null || part === undefined || part === false) return '';
  if (Array.isArray(part)) return part.map(stringify).join('');
  if (part instanceof SafeHtml) return part.value;
  return escapeHtml(String(part));
};

export const html = (strings: TemplateStringsArray, ...values: Part[]): SafeHtml =>
  raw(strings.reduce((out, str, i) => out + str + (i < values.length ? stringify(values[i] as Part) : ''), ''));
