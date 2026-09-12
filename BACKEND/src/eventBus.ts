import { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import type { AppEvent } from './domain';
import { db } from './db';

export class EventBus extends EventEmitter {
  publish<T>(type: string, payload: T, links: { sessionId?: string; workspaceId?: string } = {}) {
    const event: AppEvent<T> = {
      id: randomUUID(),
      type,
      payload,
      sessionId: links.sessionId,
      workspaceId: links.workspaceId,
      createdAt: new Date().toISOString(),
    };

    if (!['terminal.output', 'agent.input', 'resource.updated'].includes(type)) {
      db.prepare(`
        INSERT INTO session_events (id, session_id, workspace_id, type, payload_json, created_at)
        VALUES (@id, @sessionId, @workspaceId, @type, @payloadJson, @createdAt)
      `).run({
        id: event.id,
        sessionId: event.sessionId ?? null,
        workspaceId: event.workspaceId ?? null,
        type,
        payloadJson: JSON.stringify(payload),
        createdAt: event.createdAt,
      });
    }

    this.emit('event', event);
    this.emit(type, event);
    return event;
  }
}
