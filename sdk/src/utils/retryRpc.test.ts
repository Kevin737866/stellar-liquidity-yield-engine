/**
 * Tests for retry RPC wrapper.
 */

import { SorobanRpc } from 'stellar-sdk';
import {
  RetryRpcServer,
  createRetryRpcServer,
  createRetryRpcServerFromUrl,
} from './retryRpc';

// Mock the SorobanRpc.Server
jest.mock('stellar-sdk', () => {
  const actual = jest.requireActual('stellar-sdk');
  return {
    ...actual,
    SorobanRpc: {
      ...actual.SorobanRpc,
      Server: jest.fn().mockImplementation(() => ({
        serverURL: 'https://test.example.com',
        getAccount: jest.fn(),
        simulateTransaction: jest.fn(),
        sendTransaction: jest.fn(),
        getTransaction: jest.fn(),
        getLatestLedger: jest.fn(),
        getEvents: jest.fn(),
        getHealth: jest.fn(),
      })),
    },
  };
});

describe('RetryRpcServer', () => {
  let mockServer: any;
  let retryServer: RetryRpcServer;

  beforeEach(() => {
    mockServer = new SorobanRpc.Server('https://test.example.com');
    retryServer = new RetryRpcServer(mockServer);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getAccount', () => {
    it('returns account on first success', async () => {
      const mockAccount = { id: 'test-id', sequence: '1' };
      mockServer.getAccount.mockResolvedValue(mockAccount);

      const result = await retryServer.getAccount('test-address');

      expect(result).toEqual(mockAccount);
      expect(mockServer.getAccount).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockAccount = { id: 'test-id', sequence: '1' };
      mockServer.getAccount
        .mockRejectedValueOnce(new Error('network timeout'))
        .mockResolvedValue(mockAccount);

      const result = await retryServer.getAccount('test-address');

      expect(result).toEqual(mockAccount);
      expect(mockServer.getAccount).toHaveBeenCalledTimes(2);
    });

    it('does not retry when retryReads is false', async () => {
      const server = new RetryRpcServer(mockServer, { retryReads: false });
      mockServer.getAccount.mockRejectedValue(new Error('network timeout'));

      await expect(server.getAccount('test-address'))
        .rejects
        .toThrow('network timeout');

      expect(mockServer.getAccount).toHaveBeenCalledTimes(1);
    });
  });

  describe('simulateTransaction', () => {
    it('returns simulation result on first success', async () => {
      const mockResult = { result: { status: 'SUCCESS' } };
      mockServer.simulateTransaction.mockResolvedValue(mockResult);

      const result = await retryServer.simulateTransaction({} as any);

      expect(result).toEqual(mockResult);
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockResult = { result: { status: 'SUCCESS' } };
      mockServer.simulateTransaction
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValue(mockResult);

      const result = await retryServer.simulateTransaction({} as any);

      expect(result).toEqual(mockResult);
      expect(mockServer.simulateTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('sendTransaction', () => {
    it('returns send result on first success', async () => {
      const mockResult = { hash: 'test-hash', status: 'SUCCESS' };
      mockServer.sendTransaction.mockResolvedValue(mockResult);

      const result = await retryServer.sendTransaction({} as any);

      expect(result).toEqual(mockResult);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockResult = { hash: 'test-hash', status: 'SUCCESS' };
      mockServer.sendTransaction
        .mockRejectedValueOnce(new Error('service unavailable'))
        .mockResolvedValue(mockResult);

      const result = await retryServer.sendTransaction({} as any);

      expect(result).toEqual(mockResult);
      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(2);
    });

    it('does not retry when retryWrites is false', async () => {
      const server = new RetryRpcServer(mockServer, { retryWrites: false });
      mockServer.sendTransaction.mockRejectedValue(new Error('network error'));

      await expect(server.sendTransaction({} as any))
        .rejects
        .toThrow('network error');

      expect(mockServer.sendTransaction).toHaveBeenCalledTimes(1);
    });
  });

  describe('getTransaction', () => {
    it('returns transaction on first success', async () => {
      const mockTx = { status: 'SUCCESS' };
      mockServer.getTransaction.mockResolvedValue(mockTx);

      const result = await retryServer.getTransaction('test-hash');

      expect(result).toEqual(mockTx);
      expect(mockServer.getTransaction).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockTx = { status: 'SUCCESS' };
      mockServer.getTransaction
        .mockRejectedValueOnce({ status: 503, message: 'Service Unavailable' } as any)
        .mockResolvedValue(mockTx);

      const result = await retryServer.getTransaction('test-hash');

      expect(result).toEqual(mockTx);
      expect(mockServer.getTransaction).toHaveBeenCalledTimes(2);
    });
  });

  describe('getLatestLedger', () => {
    it('returns ledger on first success', async () => {
      const mockLedger = { sequence: 12345 };
      mockServer.getLatestLedger.mockResolvedValue(mockLedger);

      const result = await retryServer.getLatestLedger();

      expect(result).toEqual(mockLedger);
      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockLedger = { sequence: 12345 };
      mockServer.getLatestLedger
        .mockRejectedValueOnce(new Error('timeout'))
        .mockResolvedValue(mockLedger);

      const result = await retryServer.getLatestLedger();

      expect(result).toEqual(mockLedger);
      expect(mockServer.getLatestLedger).toHaveBeenCalledTimes(2);
    });
  });

  describe('getEvents', () => {
    it('returns events on first success', async () => {
      const mockEvents = { events: [] };
      mockServer.getEvents.mockResolvedValue(mockEvents);

      const result = await retryServer.getEvents({} as any);

      expect(result).toEqual(mockEvents);
      expect(mockServer.getEvents).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockEvents = { events: [] };
      mockServer.getEvents
        .mockRejectedValueOnce(new Error('network error'))
        .mockResolvedValue(mockEvents);

      const result = await retryServer.getEvents({} as any);

      expect(result).toEqual(mockEvents);
      expect(mockServer.getEvents).toHaveBeenCalledTimes(2);
    });
  });

  describe('getHealth', () => {
    it('returns health on first success', async () => {
      const mockHealth = { status: 'healthy' };
      mockServer.getHealth.mockResolvedValue(mockHealth);

      const result = await retryServer.getHealth();

      expect(result).toEqual(mockHealth);
      expect(mockServer.getHealth).toHaveBeenCalledTimes(1);
    });

    it('retries on transient errors', async () => {
      const mockHealth = { status: 'healthy' };
      mockServer.getHealth
        .mockRejectedValueOnce(new Error('connection refused'))
        .mockResolvedValue(mockHealth);

      const result = await retryServer.getHealth();

      expect(result).toEqual(mockHealth);
      expect(mockServer.getHealth).toHaveBeenCalledTimes(2);
    });
  });

  describe('getUnderlyingServer', () => {
    it('returns the underlying server', () => {
      const underlying = retryServer.getUnderlyingServer();

      expect(underlying).toBe(mockServer);
    });
  });

  describe('serverURL', () => {
    it('returns the server URL', () => {
      expect(retryServer.serverURL).toBe('https://test.example.com');
    });
  });
});

describe('createRetryRpcServer', () => {
  it('creates a RetryRpcServer from a SorobanRpc.Server', () => {
    const mockServer = new SorobanRpc.Server('https://test.example.com');
    const retryServer = createRetryRpcServer(mockServer);

    expect(retryServer).toBeInstanceOf(RetryRpcServer);
    expect(retryServer.getUnderlyingServer()).toBe(mockServer);
  });

  it('applies custom options', () => {
    const mockServer = new SorobanRpc.Server('https://test.example.com');
    const retryServer = createRetryRpcServer(mockServer, {
      maxRetries: 5,
      retryReads: false,
    });

    expect(retryServer).toBeInstanceOf(RetryRpcServer);
  });
});

describe('createRetryRpcServerFromUrl', () => {
  it('creates a RetryRpcServer from a URL', () => {
    const retryServer = createRetryRpcServerFromUrl('https://test.example.com');

    expect(retryServer).toBeInstanceOf(RetryRpcServer);
    expect(retryServer.serverURL).toBe('https://test.example.com');
  });

  it('applies custom options', () => {
    const retryServer = createRetryRpcServerFromUrl('https://test.example.com', {
      maxRetries: 5,
      retryWrites: false,
    });

    expect(retryServer).toBeInstanceOf(RetryRpcServer);
  });
});
