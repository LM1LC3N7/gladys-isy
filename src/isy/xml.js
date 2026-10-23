// -----------------------------------------------------------------------------
// A small XML reader for the answers and events of the controller (pyisy
// reads them with xml.dom.minidom). Only what the ISY REST API sends:
// elements, attributes, text, the five entities and numeric references; the
// declaration, comments, processing instructions, CDATA and DOCTYPE are
// skipped (a DOCTYPE never defines anything here: no entity expansion).
//
// Bounded and linear: one forward pass with indexOf, no backtracking, no
// recursion (an explicit stack, at most LIMITS.xmlDepth deep), at most
// LIMITS.xmlElements elements; the input itself is bounded by the reader of
// the answer. Attributes are kept in objects without prototype, so a name
// such as `__proto__` is only a key.
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

export class XmlError extends Error {}

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

/** Decodes the entities of a text or an attribute value (one pass). */
export function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]{2,4});/gi, (whole, name) => {
    if (name[0] === '#') {
      const code =
        name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (
        !Number.isInteger(code) ||
        code < 0x20 ||
        code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff)
      ) {
        return '';
      }
      return String.fromCodePoint(code);
    }
    return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : whole;
  });
}

const NAME = /^[A-Za-z_][\w.:-]{0,63}$/;

function element(name, attrs) {
  return { name, attrs, children: [], text: '' };
}

/** Reads the attributes of a start tag (the text between the name and `>`). */
function attributes(text) {
  const attrs = Object.create(null);
  const re = /([A-Za-z_][\w.:-]{0,63})\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  let count = 0;
  while ((match = re.exec(text)) !== null) {
    count += 1;
    if (count > 32) break;
    attrs[match[1]] = decode(match[3] ?? match[4] ?? '');
  }
  return attrs;
}

/**
 * Parses a document; returns its root element `{ name, attrs, children, text }`
 * (`text`: the text directly inside, trimmed, at most 4 KB). Throws XmlError.
 */
export function parseXml(input) {
  if (typeof input !== 'string') throw new XmlError('not a text');
  const root = element('#document', Object.create(null));
  const stack = [root];
  let count = 0;
  let i = 0;
  const n = input.length;
  while (i < n) {
    const lt = input.indexOf('<', i);
    const textEnd = lt === -1 ? n : lt;
    if (textEnd > i) {
      const top = stack.at(-1);
      if (top !== root && top.text.length < 4096) {
        top.text += decode(input.slice(i, Math.min(textEnd, i + 4096)));
      }
    }
    if (lt === -1) break;
    const next = input[lt + 1];
    if (next === '?') {
      const end = input.indexOf('?>', lt + 2);
      if (end === -1) throw new XmlError('unterminated declaration');
      i = end + 2;
      continue;
    }
    if (next === '!') {
      if (input.startsWith('<!--', lt)) {
        const end = input.indexOf('-->', lt + 4);
        if (end === -1) throw new XmlError('unterminated comment');
        i = end + 3;
      } else if (input.startsWith('<![CDATA[', lt)) {
        const end = input.indexOf(']]>', lt + 9);
        if (end === -1) throw new XmlError('unterminated CDATA');
        const top = stack.at(-1);
        if (top !== root && top.text.length < 4096)
          top.text += input.slice(lt + 9, Math.min(end, lt + 9 + 4096));
        i = end + 3;
      } else {
        // DOCTYPE and the like: skipped up to the next `>` (no internal subset is used).
        const end = input.indexOf('>', lt + 2);
        if (end === -1) throw new XmlError('unterminated declaration');
        i = end + 1;
      }
      continue;
    }
    const gt = input.indexOf('>', lt + 1);
    if (gt === -1) throw new XmlError('unterminated tag');
    if (next === '/') {
      const name = input.slice(lt + 2, gt).trim();
      const top = stack.at(-1);
      if (stack.length === 1 || top.name !== name) throw new XmlError('mismatched end tag');
      top.text = top.text.trim();
      stack.pop();
      i = gt + 1;
      continue;
    }
    let body = input.slice(lt + 1, gt);
    const selfClosing = body.endsWith('/');
    if (selfClosing) body = body.slice(0, -1);
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    if (!NAME.test(name)) throw new XmlError('invalid tag name');
    count += 1;
    if (count > LIMITS.xmlElements) throw new XmlError('too many elements');
    const el = element(name, space === -1 ? Object.create(null) : attributes(body.slice(space)));
    const parent = stack.at(-1);
    parent.children.push(el);
    if (!selfClosing) {
      if (stack.length > LIMITS.xmlDepth) throw new XmlError('too deep');
      stack.push(el);
    }
    i = gt + 1;
  }
  if (stack.length !== 1) throw new XmlError('unterminated element');
  const first = root.children[0];
  if (!first || root.children.length !== 1) throw new XmlError('no single root element');
  return first;
}

/** The first child element named `name`, or undefined. */
export const child = (el, name) => el?.children.find((c) => c.name === name);

/** The text of the first child element named `name`, or undefined. */
export const childText = (el, name) => child(el, name)?.text;

/** Every descendant element named `name`, in document order (iterative). */
export function descendants(el, name, max = Infinity) {
  const out = [];
  if (!el) return out;
  const stack = [...el.children].reverse();
  while (stack.length > 0 && out.length < max) {
    const node = stack.pop();
    if (node.name === name) out.push(node);
    for (let k = node.children.length - 1; k >= 0; k -= 1) stack.push(node.children[k]);
  }
  return out;
}
