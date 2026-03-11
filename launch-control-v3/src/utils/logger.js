const level = process.env.LOG_LEVEL || 'info';
const levels = { debug: 0, info: 1, warn: 2, error: 3 };

function log(lvl, ...args) {
  if (levels[lvl] >= levels[level]) {
    const ts = new Date().toISOString();
    const prefix = `[${ts}] [${lvl.toUpperCase()}]`;
    if (lvl === 'error') {
      console.error(prefix, ...args);
    } else {
      console.log(prefix, ...args);
    }
  }
}

export const logger = {
  debug: (...args) => log('debug', ...args),
  info:  (...args) => log('info',  ...args),
  warn:  (...args) => log('warn',  ...args),
  error: (...args) => log('error', ...args),
  signal: (sig) => log('info', `SIGNAL ${sig.grade} ${sig.ticker} ${sig.direction} composite=${sig.composite_raw} tier=${sig.signal_tier}`),
};

export default logger;
