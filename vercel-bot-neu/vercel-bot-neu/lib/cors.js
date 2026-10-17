function setCors(res) {
  const origin = process.env.ALLOWED_ORIGIN || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Signature-Ed25519, X-Signature-Timestamp');
}
function handlePreflight(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return true; }
  return false;
}
module.exports = { setCors, handlePreflight };
