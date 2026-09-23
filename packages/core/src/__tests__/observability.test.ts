import { EventEmitter } from 'node:events';
import { BridgeService } from '../bridge-service.js';
import {
  WebSocketStudioTransport,
  MAX_STUDIO_BUFFERED_BYTES,
  type StudioServerEvent,
  type StudioSocket,
  type StudioStatusEvent,
} from '../studio-transport.js';
import {
  getObservabilitySnapshot,
  observeFault,
  observeOperation,
  resetObservability,
  setObservabilityLogger,
  type ObservabilityLogEvent,
} from '../observability.js';

class FakeStudioSocket extends EventEmitter implements StudioSocket {
  readonly chunks: string[] = [];
  readyState = 1;
  bufferedAmount = 0;
  ended = false;
  closeCode?: number;
  closeReason?: string;
  autoComplete = true;
  private completion?: (error?: Error) => void;

  send(chunk: string, callback: (error?: Error) => void): void {
    this.chunks.push(chunk);
    this.bufferedAmount += Buffer.byteLength(chunk);
    this.completion = callback;
    if (this.autoComplete) this.completeSend();
  }

  completeSend(error?: Error): void {
    const completion = this.completion;
    this.completion = undefined;
    this.bufferedAmount = 0;
    completion?.(error);
  }

  close(code?: number, reason?: string): void {
    this.ended = true;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit('close');
  }

  terminate(): void {
    this.readyState = 3;
    this.emit('close');
  }

  respond(requestId: string, response?: unknown, error?: unknown): void {
    this.emit('message', Buffer.from(JSON.stringify({ kind: 'response', requestId, response, error })), false);
  }

  events(): StudioServerEvent[] {
    return this.chunks.map((chunk) => JSON.parse(chunk) as StudioServerEvent);
  }
}

const STATUS: StudioStatusEvent = {
  kind: 'status',
  knownPeer: true,
  mcpConnected: true,
  serverVersion: '3.0.2',
  pluginVersion: '3.0.2',
  pluginVariant: 'main',
};

function registerPeer(bridge: BridgeService, peerId: string, instanceId: string, role: string): void {
  const result = bridge.registerPeer({
    peerId,
    transportPeerId: peerId,
    instanceId,
    role,
    placeId: 0,
    placeName: '',
  });
  if (!result.ok) throw new Error(`registerPeer failed: ${result.error.code}`);
}

function outcomeCount(tool: string | undefined, outcome: string): number {
  if (!tool) return 0;
  const snapshot = getObservabilitySnapshot();
  const stats = snapshot.tools[tool];
  if (!stats) return 0;
  return stats.outcomes[outcome as keyof typeof stats.outcomes] ?? 0;
}

describe('observability', () => {
  let bridge: BridgeService;
  const transports: WebSocketStudioTransport[] = [];

  beforeEach(() => {
    resetObservability();
    setObservabilityLogger(undefined);
    jest.useFakeTimers();
    bridge = new BridgeService();
  });

  afterEach(() => {
    for (const transport of transports.splice(0)) transport.close();
    bridge.clearAllPendingRequests();
    setObservabilityLogger(undefined);
    resetObservability();
    jest.useRealTimers();
  });

  function openTransport(target: BridgeService, transportPeerId: string): FakeStudioSocket {
    const transport = new WebSocketStudioTransport(target);
    transports.push(transport);
    const socket = new FakeStudioSocket();
    const handle = transport.open(transportPeerId, socket, () => STATUS);
    if (!handle) throw new Error('transport.open failed');
    return socket;
  }

  test('records only tool/duration/bytes/outcome and never payloads or identities', async () => {
    const events: ObservabilityLogEvent[] = [];
    setObservabilityLogger((event) => events.push(event));
    registerPeer(bridge, 'obs-log-peer', 'instance:obs-log', 'edit');

    const pending = bridge.sendRequest(
      '/api/secret-probe',
      { token: 'OBS_SECRET_TOKEN_7f3a9c', source: 'local OBS_SECRET_SOURCE_xq2 = 1' },
      'obs-log-peer',
      30_000,
      undefined,
      'obs-log-op',
    );
    bridge.claimNextRequestForTransport('obs-log-peer', 'socket');
    expect(bridge.settleTransportResponse('obs-log-peer', 'obs-log-op', { result: 'OBS_SECRET_RESP_zz51' }))
      .toBe('accepted');
    await expect(pending).resolves.toEqual({ result: 'OBS_SECRET_RESP_zz51' });

    expect(events.length).toBeGreaterThan(0);
    const allowed = new Set(['timestamp', 'level', 'event', 'tool', 'outcome', 'durationMs', 'bytes']);
    for (const event of events) {
      for (const key of Object.keys(event)) expect(allowed.has(key)).toBe(true);
      expect(typeof event.tool).toBe('string');
      expect(typeof event.outcome).toBe('string');
    }
    const logged = JSON.stringify(events);
    expect(logged).not.toContain('OBS_SECRET');
    expect(logged).not.toContain('obs-log-peer');
    expect(logged).not.toContain('instance:obs-log');
    const snapshotJson = JSON.stringify(getObservabilitySnapshot());
    expect(snapshotJson).not.toContain('OBS_SECRET');
    expect(snapshotJson).not.toContain('obs-log-peer');

    const stats = getObservabilitySnapshot().tools['/api/secret-probe'];
    expect(stats).toBeDefined();
    expect(stats.outcomes.success).toBe(1);
    expect(stats.totalBytes).toBeGreaterThanOrEqual(0);
  });

  test('defaults are inert: no logger, no behavior change, observers never throw', async () => {
    registerPeer(bridge, 'obs-default-peer', 'instance:obs-default', 'edit');
    const pending = bridge.sendRequest('/api/ok', {}, 'obs-default-peer', 30_000, undefined, 'obs-default-op');
    bridge.claimNextRequestForTransport('obs-default-peer', 'socket');
    bridge.settleTransportResponse('obs-default-peer', 'obs-default-op', { ok: true });
    await expect(pending).resolves.toEqual({ ok: true });

    expect(outcomeCount('/api/ok', 'success')).toBe(1);
    expect(() => {
      setObservabilityLogger(undefined);
      observeOperation(null as never);
      observeOperation({ tool: 'evil tool\nwith source', outcome: 'success' });
      observeFault('bogus' as never);
      observeFault('timeout', undefined);
    }).not.toThrow();
    // Whitespace/control payloads can never become metric labels.
    expect(getObservabilitySnapshot().tools['invalid_tool']).toBeDefined();
    expect(getObservabilitySnapshot().tools['evil']).toBeUndefined();
  });

  test('fault injection: disconnect is observed with evidence preserved', async () => {
    registerPeer(bridge, 'obs-disc-peer', 'instance:obs-disc', 'edit');
    const faultsBefore = getObservabilitySnapshot().faults.disconnect;
    const pending = bridge.sendRequest('/api/mutate', {}, 'obs-disc-peer', 30_000, undefined, 'obs-disconnect');
    const failure = expect(pending).rejects.toMatchObject({
      code: 'request_disconnected',
      details: { requestId: 'obs-disconnect', stage: 'dispatched', outcome: 'unknown' },
    });
    bridge.claimNextRequestForTransport('obs-disc-peer', 'socket');
    bridge.unregisterPeer('obs-disc-peer');
    await failure;

    expect(bridge.getRequestStatus('obs-disconnect')).toMatchObject({ state: 'disconnected', outcome: 'unknown' });
    expect(getObservabilitySnapshot().faults.disconnect - faultsBefore).toBe(1);
    expect(outcomeCount('/api/mutate', 'disconnected')).toBe(1);
  });

  test('fault injection: timeout is observed and only the waiter is removed', async () => {
    registerPeer(bridge, 'obs-timeout-peer', 'instance:obs-timeout', 'edit');
    const faultsBefore = getObservabilitySnapshot().faults.timeout;
    const pending = bridge.sendRequest('/api/mutate', { value: 1 }, 'obs-timeout-peer', 1000, undefined, 'obs-timeout');
    const failure = expect(pending).rejects.toMatchObject({
      code: 'request_timeout',
      details: { requestId: 'obs-timeout', stage: 'dispatched', outcome: 'unknown' },
    });
    bridge.claimNextRequestForTransport('obs-timeout-peer', 'socket');
    jest.advanceTimersByTime(1000);
    await failure;

    expect(bridge.getPendingRequestCount()).toBe(0);
    expect(bridge.getRequestStatus('obs-timeout')).toMatchObject({ state: 'timed_out', outcome: 'unknown' });
    expect(getObservabilitySnapshot().faults.timeout - faultsBefore).toBe(1);
    expect(outcomeCount('/api/mutate', 'timeout')).toBe(1);
    // Late settlement still authenticates and records the operation outcome.
    expect(bridge.settleTransportResponse('obs-timeout-peer', 'obs-timeout', { recovered: true })).toBe('accepted');
    expect(outcomeCount('/api/mutate', 'success')).toBe(1);
  });

  test('fault injection: retention eviction is observed under capacity pressure', async () => {
    registerPeer(bridge, 'obs-evict-peer', 'instance:obs-evict', 'edit');
    const faultsBefore = getObservabilitySnapshot().faults.eviction;
    for (let index = 0; index < 1025; index++) {
      const id = `obs-evict-${index}`;
      const pending = bridge.sendRequest('/api/mutate', {}, 'obs-evict-peer', 30_000, undefined, id);
      bridge.claimNextRequestForTransport('obs-evict-peer', 'socket');
      bridge.settleTransportResponse('obs-evict-peer', id, { index });
      await pending;
    }
    expect(bridge.getRequestStatus('obs-evict-0')).toMatchObject({
      outcome: 'success',
      resultUnavailable: { reason: 'retention_capacity' },
    });
    expect(bridge.getRequestStatus('obs-evict-1024')?.response).toEqual({ index: 1024 });
    expect(getObservabilitySnapshot().faults.eviction - faultsBefore).toBeGreaterThanOrEqual(1);
    expect(outcomeCount('/api/mutate', 'success')).toBe(1025);
  });

  test('fault injection: saturation is observed at admission and transport backpressure', async () => {
    registerPeer(bridge, 'obs-sat-peer', 'instance:obs-sat', 'edit');
    const faultsBefore = getObservabilitySnapshot().faults.saturation;
    const controllers = Array.from({ length: 1024 }, () => new AbortController());
    const pending = controllers.map((controller, index) =>
      bridge.sendRequest('/api/mutate', {}, 'obs-sat-peer', 30_000, controller.signal, `obs-sat-${index}`)
        .catch((error: unknown) => error));
    await expect(bridge.sendRequest('/api/mutate', {}, 'obs-sat-peer')).rejects.toMatchObject({
      code: 'request_capacity_exceeded',
      details: { outcome: 'not_executed' },
    });
    expect(getObservabilitySnapshot().faults.saturation - faultsBefore).toBeGreaterThanOrEqual(1);
    for (const controller of controllers) controller.abort();
    await Promise.all(pending);
    expect(bridge.getPendingRequestCount()).toBe(0);
    const admitted = bridge.sendRequest('/api/mutate', {}, 'obs-sat-peer', 30_000, undefined, 'obs-sat-admitted');
    bridge.claimNextRequestForTransport('obs-sat-peer', 'socket');
    bridge.settleTransportResponse('obs-sat-peer', 'obs-sat-admitted', true);
    await expect(admitted).resolves.toBe(true);

    // Transport backpressure: a full socket buffer saturates delivery and disconnects.
    const saturated = new BridgeService();
    registerPeer(saturated, 'obs-t-peer', 'instance:obs-t', 'edit');
    const socket = openTransport(saturated, 'obs-t-peer');
    socket.bufferedAmount = MAX_STUDIO_BUFFERED_BYTES;
    const transportFaultsBefore = getObservabilitySnapshot().faults.saturation;
    const transportDisconnectsBefore = getObservabilitySnapshot().faults.disconnect;
    const blocked = saturated.sendRequest('/api/mutate', {}, 'obs-t-peer', 30_000, undefined, 'obs-transport-sat');
    const blockedFailure = expect(blocked).rejects.toMatchObject({ code: 'request_disconnected' });
    expect(socket.closeCode).toBe(1013);
    expect(getObservabilitySnapshot().faults.saturation - transportFaultsBefore).toBeGreaterThanOrEqual(1);
    expect(getObservabilitySnapshot().faults.disconnect - transportDisconnectsBefore).toBeGreaterThanOrEqual(1);
    saturated.clearAllPendingRequests();
    await blockedFailure;
  });
});
