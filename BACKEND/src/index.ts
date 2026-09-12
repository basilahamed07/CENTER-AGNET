import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import { initDb, markInterruptedSessionsResumable } from './db';
import { EventBus } from './eventBus';
import { createApiRouter, errorMiddleware } from './routes';
import { ProcessManager } from './processManager';
import { inputSchema, resizeSchema } from './validation';
import { startGitMonitor } from './gitMonitor';
import { logger } from './logger';

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:3002', 'http://127.0.0.1:3002'],
    methods: ['GET', 'POST']
  }
});

const PORT = Number(process.env.PORT || 4242);
const HOST = process.env.HOST || '127.0.0.1';

process.on('uncaughtException', (error: NodeJS.ErrnoException) => {
  const message = error.stack ?? error.message;
  if (error.code === 'EPERM' && message.includes('pipe\\conpty')) {
    logger.error('suppressed node-pty ConPTY pipe permission failure', { error: message });
    return;
  }
  logger.error('uncaught exception', { error: message });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error('unhandled rejection', { error: reason instanceof Error ? reason.stack ?? reason.message : String(reason) });
});

initDb();
markInterruptedSessionsResumable();

const events = new EventBus();
const processManager = new ProcessManager(events);

app.use(cors({ origin: true }));
app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', manager: 'agent-control-center', pid: process.pid });
});

app.use('/api', createApiRouter(processManager));
app.use(errorMiddleware);

io.on('connection', (socket) => {
  logger.info('websocket connected', { socketId: socket.id });
  socket.emit('manager.state', {
    type: 'manager.state',
    payload: { runningSessionIds: processManager.listRunningSessionIds() },
  });

  const forward = (event: unknown) => {
    if (event && typeof event === 'object' && 'type' in event) {
      const eventType = String(event.type);
      if (['terminal.output', 'agent.input', 'resource.updated', 'git.changed'].includes(eventType)) return;
    }
    socket.emit('manager.event', event);
  };
  events.on('event', forward);

  socket.on('terminal.attach', (message: { sessionId: string }) => {
    socket.join(`session:${message.sessionId}`);
    const buffered = processManager.getBufferedOutput(message.sessionId);
    if (buffered) socket.emit('terminal.output', { sessionId: message.sessionId, payload: { data: buffered } });
  });

  socket.on('terminal.input', (message: unknown) => {
    const parsed = inputSchema.safeParse(message);
    if (!parsed.success) {
      logger.warn('terminal.input rejected', { socketId: socket.id, issues: parsed.error.issues });
      return;
    }
    processManager.write(parsed.data.sessionId, parsed.data.data);
  });

  socket.on('terminal.resize', (message: unknown) => {
    const parsed = resizeSchema.safeParse(message);
    if (!parsed.success) {
      // Frontend can emit a fit before the pane has layout (cols/rows too small).
      // Clamping is safer than throwing: a ZodError here crashed the manager.
      const raw = (message ?? {}) as { sessionId?: unknown; cols?: unknown; rows?: unknown };
      if (typeof raw.sessionId !== 'string' || raw.sessionId.length === 0) return;
      const cols = Math.max(20, Math.min(300, Math.floor(Number(raw.cols) || 0) || 20));
      const rows = Math.max(5, Math.min(120, Math.floor(Number(raw.rows) || 0) || 5));
      processManager.resize(raw.sessionId, cols, rows);
      return;
    }
    processManager.resize(parsed.data.sessionId, parsed.data.cols, parsed.data.rows);
  });

  socket.on('disconnect', () => {
    events.off('event', forward);
    logger.info('websocket disconnected', { socketId: socket.id });
  });
});

events.on('terminal.output', (event) => {
  const envelope = event as { sessionId?: string; payload: unknown };
  if (envelope.sessionId) io.to(`session:${envelope.sessionId}`).emit('terminal.output', envelope);
});

startGitMonitor(events);
setInterval(() => void processManager.sampleResources(), 5000);
setInterval(() => processManager.computeStuckSignals(), 30000);

httpServer.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    logger.warn('manager port already in use', { host: HOST, port: PORT });
    process.exit(0);
  }
  logger.error('manager server error', { error: error.stack ?? error.message });
  process.exit(1);
});

httpServer.listen(PORT, HOST, () => {
  logger.info('manager started', { url: `http://${HOST}:${PORT}` });
});
