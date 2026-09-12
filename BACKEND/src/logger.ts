type LogLevel = 'info' | 'warn' | 'error';

function write(level: LogLevel, message: string, meta?: Record<string, unknown>) {
  console.log(JSON.stringify({ level, message, time: new Date().toISOString(), ...(meta ? { meta } : {}) }));
}

export const logger = {
  info: (message: string, meta?: Record<string, unknown>) => write('info', message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => write('warn', message, meta),
  error: (message: string, meta?: Record<string, unknown>) => write('error', message, meta),
};
