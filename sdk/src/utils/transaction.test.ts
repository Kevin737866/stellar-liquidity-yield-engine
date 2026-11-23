import { checkRpcHealth, RpcHealthCheckError } from './transaction';

describe('checkRpcHealth', () => {
  const endpoint = 'https://soroban.example.com';

  it('returns a report for a healthy endpoint', async () => {
    const server = {
      serverURL: { toString: () => endpoint },
      getHealth: jest.fn().mockResolvedValue({ status: 'healthy' }),
    };

    const report = await checkRpcHealth(server as any, { timeoutMs: 100 });

    expect(report.endpoint).toBe(endpoint);
    expect(report.status).toBe('healthy');
    expect(report.latencyMs).toBeGreaterThanOrEqual(0);
    expect(report.checkedAt).toBeGreaterThan(0);
    expect(server.getHealth).toHaveBeenCalledTimes(1);
  });

  it('rejects if the endpoint reports an unhealthy status', async () => {
    const server = {
      serverURL: { toString: () => endpoint },
      getHealth: jest.fn().mockResolvedValue({ status: 'unhealthy' }),
    };

    await expect(checkRpcHealth(server as any)).rejects.toMatchObject({
      name: 'RpcHealthCheckError',
      endpoint,
    });
  });

  it('reports transport failures with endpoint context', async () => {
    const server = {
      serverURL: { toString: () => endpoint },
      getHealth: jest.fn().mockRejectedValue(new Error('connection refused')),
    };

    await expect(checkRpcHealth(server as any)).rejects.toThrow(
      `${endpoint}: connection refused`,
    );
  });

  it('times out when the endpoint does not respond', async () => {
    const server = {
      serverURL: { toString: () => endpoint },
      getHealth: jest.fn().mockReturnValue(new Promise(() => {})),
    };

    await expect(checkRpcHealth(server as any, { timeoutMs: 1 })).rejects.toBeInstanceOf(
      RpcHealthCheckError,
    );
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid timeout %s',
    async (timeoutMs) => {
      const server = {
        serverURL: { toString: () => endpoint },
        getHealth: jest.fn(),
      };

      await expect(
        checkRpcHealth(server as any, { timeoutMs }),
      ).rejects.toThrow('timeoutMs must be a positive finite number');
      expect(server.getHealth).not.toHaveBeenCalled();
    },
  );
});
