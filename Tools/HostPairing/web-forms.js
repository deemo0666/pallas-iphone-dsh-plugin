export async function readForm(req) {
  if ((req.headers['content-type'] ?? '').split(';')[0] !== 'application/x-www-form-urlencoded') throw new Error('invalid_form');
  const chunks = [];
  let size = 0;
  for await (const bytes of req) {
    size += bytes.length;
    if (size > 8192) throw new Error('form_too_large');
    chunks.push(bytes);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}
