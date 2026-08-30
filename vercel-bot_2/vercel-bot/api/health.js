const { handlePreflight } = require('../lib/cors');

module.exports = (req, res) => {
  if (handlePreflight(req, res)) return;
  res.status(200).json({ status: 'ok' });
};
