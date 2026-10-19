// Minimal structured logger (JSON lines). Silent under NODE_ENV=test.
const write = (level, msg, extra) => {
  if (process.env.NODE_ENV === 'test') return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' ? console.error : console.log)(line);
};

export const logger = {
  info: (msg, extra) => write('info', msg, extra),
  warn: (msg, extra) => write('warn', msg, extra),
  error: (msg, extra) => write('error', msg, extra),
};
